package apitokens

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"math/big"
	"net/http"
	"strconv"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"
	"github.com/pocketbase/pocketbase/tools/types"
)

const (
	CollectionName = "api_tokens"

	headerAPIKey = "X-API-Key"
	tokenPrefix  = "pb_"

	accessKeyBytes  = 16
	accessKeyLength = 25
	secretBytes     = 32
	secretLength    = 50

	RequestContextAPIToken = "apiToken"

	requestEventKeyAPITokenAuth = "betterPocketBaseApiTokenAuth"

	defaultPage    = 1
	defaultPerPage = 30
	maxPerPage     = 100
)

var (
	errInvalidToken = errors.New("invalid api token")
	errExpiredToken = errors.New("expired api token")
	errRevokedToken = errors.New("revoked api token")
)

type tokenParts struct {
	Access string
	Secret string
}

type createRequest struct {
	Name      string `json:"name" form:"name"`
	UserID    string `json:"userId" form:"userId"`
	ExpiresAt string `json:"expiresAt" form:"expiresAt"`
}

type tokenResponse struct {
	ID         string `json:"id"`
	UserID     string `json:"userId"`
	Name       string `json:"name"`
	AccessKey  string `json:"accessKey"`
	Status     string `json:"status"`
	Created    string `json:"created"`
	Updated    string `json:"updated"`
	ExpiresAt  string `json:"expiresAt"`
	RevokedAt  string `json:"revokedAt"`
	LastUsedAt string `json:"lastUsedAt"`
	CreatedBy  string `json:"createdBy"`
	RevokedBy  string `json:"revokedBy"`
}

type createResponse struct {
	Token string        `json:"token"`
	Item  tokenResponse `json:"item"`
}

type listResponse struct {
	Page       int             `json:"page"`
	PerPage    int             `json:"perPage"`
	TotalItems int             `json:"totalItems"`
	TotalPages int             `json:"totalPages"`
	Items      []tokenResponse `json:"items"`
}

// Register wires API token authentication, lifecycle hooks, and management routes.
func Register(app core.App) {
	app.OnServe().Bind(&hook.Handler[*core.ServeEvent]{
		Id: "betterPocketBaseApiTokens",
		Func: func(e *core.ServeEvent) error {
			e.Router.Bind(apiTokenAuthMiddleware())

			group := e.Router.Group("/api/api-tokens").Bind(jwtOnlyManagementAuth())
			group.GET("", listTokens)
			group.POST("", createToken)
			group.DELETE("/{id}", revokeToken)

			return e.Next()
		},
	})

	app.OnRecordDeleteExecute("users").BindFunc(func(e *core.RecordEvent) error {
		if err := deleteTokensForUser(e.App, e.Record.Id); err != nil {
			return err
		}

		return e.Next()
	})
}

func apiTokenAuthMiddleware() *hook.Handler[*core.RequestEvent] {
	return &hook.Handler[*core.RequestEvent]{
		Id:       "betterPocketBaseLoadApiToken",
		Priority: apis.DefaultLoadAuthTokenMiddlewarePriority - 1,
		Func: func(e *core.RequestEvent) error {
			rawToken := strings.TrimSpace(e.Request.Header.Get(headerAPIKey))
			if rawToken == "" {
				return e.Next()
			}

			if strings.TrimSpace(e.Request.Header.Get("Authorization")) != "" || e.Auth != nil {
				return e.BadRequestError("Ambiguous authentication credentials.", nil)
			}

			parts, err := parseToken(rawToken)
			if err != nil {
				e.App.Logger().Debug("api token authentication failed", "reason", "malformed")
				return e.UnauthorizedError("Invalid API key.", nil)
			}

			tokenRecord, user, err := authenticateToken(e, parts)
			if err != nil {
				logTokenAuthFailure(e.App, parts.Access, err)
				return e.UnauthorizedError("Invalid API key.", nil)
			}

			e.Auth = user
			e.Set(core.RequestEventKeyInfoContext, RequestContextAPIToken)
			e.Set(requestEventKeyAPITokenAuth, true)

			tokenRecord.Set("lastUsedAt", types.NowDateTime())
			if err := e.App.Save(tokenRecord); err != nil {
				e.App.Logger().Warn(
					"failed to update api token lastUsedAt",
					"accessKey", parts.Access,
					"error", err,
				)
			}

			return e.Next()
		},
	}
}

func jwtOnlyManagementAuth() *hook.Handler[*core.RequestEvent] {
	return &hook.Handler[*core.RequestEvent]{
		Id: "betterPocketBaseRequireJwtTokenManagementAuth",
		Func: func(e *core.RequestEvent) error {
			if isAPITokenAuth(e) {
				return e.UnauthorizedError("The request requires valid record authorization token.", nil)
			}

			if e.Auth == nil {
				return e.UnauthorizedError("The request requires valid record authorization token.", nil)
			}

			if e.Auth.IsSuperuser() || e.Auth.Collection().Name == "users" {
				return e.Next()
			}

			return e.ForbiddenError("The authorized record is not allowed to manage API tokens.", nil)
		},
	}
}

func listTokens(e *core.RequestEvent) error {
	page := boundedQueryInt(e, "page", defaultPage, 1, math.MaxInt)
	perPage := boundedQueryInt(e, "perPage", defaultPerPage, 1, maxPerPage)
	offset := (page - 1) * perPage

	exprs := listTokenExpressions(e)

	total, err := e.App.CountRecords(CollectionName, exprs...)
	if err != nil {
		return e.InternalServerError("Failed to list API tokens.", err)
	}

	records := []*core.Record{}
	query := e.App.RecordQuery(CollectionName).
		OrderBy("created DESC").
		Limit(int64(perPage)).
		Offset(int64(offset))
	for _, expr := range exprs {
		query.AndWhere(expr)
	}
	if err := query.All(&records); err != nil {
		return e.InternalServerError("Failed to list API tokens.", err)
	}

	items := make([]tokenResponse, 0, len(records))
	now := types.NowDateTime()
	for _, record := range records {
		items = append(items, exportToken(record, now))
	}

	return e.JSON(http.StatusOK, listResponse{
		Page:       page,
		PerPage:    perPage,
		TotalItems: int(total),
		TotalPages: totalPages(int(total), perPage),
		Items:      items,
	})
}

func createToken(e *core.RequestEvent) error {
	body := createRequest{}
	if err := e.BindBody(&body); err != nil {
		return e.BadRequestError("Invalid request body.", err)
	}

	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" {
		return e.BadRequestError("API token name is required.", nil)
	}
	if len([]rune(body.Name)) > 200 {
		return e.BadRequestError("API token name is too long.", nil)
	}

	targetUserID, err := resolveTargetUserID(e, strings.TrimSpace(body.UserID))
	if err != nil {
		return err
	}

	targetUser, err := e.App.FindRecordById("users", targetUserID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return e.BadRequestError("Invalid target user.", nil)
		}
		return e.InternalServerError("Failed to load target user.", err)
	}
	if targetUser.Collection().Name != "users" {
		return e.BadRequestError("Invalid target user.", nil)
	}

	expiresAt, err := parseOptionalFutureDate(body.ExpiresAt)
	if err != nil {
		return e.BadRequestError("Invalid expiresAt value.", err)
	}

	parts, rawToken, err := newTokenParts()
	if err != nil {
		return e.InternalServerError("Failed to generate API token.", err)
	}

	collection, err := e.App.FindCollectionByNameOrId(CollectionName)
	if err != nil {
		return e.InternalServerError("API token collection is not available.", err)
	}

	record := core.NewRecord(collection)
	record.Set("userId", targetUser.Id)
	record.Set("name", body.Name)
	record.Set("accessKey", parts.Access)
	record.Set("secretHash", hashSecret(parts.Secret))
	record.Set("createdBy", actorID(e.Auth))
	if !expiresAt.IsZero() {
		record.Set("expiresAt", expiresAt)
	}

	if err := e.App.Save(record); err != nil {
		return e.InternalServerError("Failed to create API token.", err)
	}

	return e.JSON(http.StatusCreated, createResponse{
		Token: rawToken,
		Item:  exportToken(record, types.NowDateTime()),
	})
}

func revokeToken(e *core.RequestEvent) error {
	id := e.Request.PathValue("id")
	if id == "" {
		return e.NotFoundError("API token not found.", nil)
	}

	record, err := e.App.FindRecordById(CollectionName, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return e.NotFoundError("API token not found.", nil)
		}
		return e.InternalServerError("Failed to load API token.", err)
	}

	if !e.Auth.IsSuperuser() && record.GetString("userId") != e.Auth.Id {
		return e.NotFoundError("API token not found.", nil)
	}

	if record.GetDateTime("revokedAt").IsZero() {
		record.Set("revokedAt", types.NowDateTime())
		record.Set("revokedBy", actorID(e.Auth))
		if err := e.App.Save(record); err != nil {
			return e.InternalServerError("Failed to revoke API token.", err)
		}
	}

	return e.NoContent(http.StatusNoContent)
}

func authenticateToken(e *core.RequestEvent, parts tokenParts) (*core.Record, *core.Record, error) {
	tokenRecord, err := e.App.FindFirstRecordByData(CollectionName, "accessKey", parts.Access)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil, errInvalidToken
		}
		return nil, nil, err
	}

	if !verifySecret(parts.Secret, tokenRecord.GetString("secretHash")) {
		return nil, nil, errInvalidToken
	}

	if !tokenRecord.GetDateTime("revokedAt").IsZero() {
		return nil, nil, errRevokedToken
	}

	now := types.NowDateTime()
	expiresAt := tokenRecord.GetDateTime("expiresAt")
	if !expiresAt.IsZero() && !expiresAt.After(now) {
		return nil, nil, errExpiredToken
	}

	user, err := e.App.FindRecordById("users", tokenRecord.GetString("userId"))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil, errInvalidToken
		}
		return nil, nil, err
	}
	if user.Collection().Name != "users" {
		return nil, nil, errInvalidToken
	}

	e.Set(core.RequestEventKeyInfoContext, RequestContextAPIToken)
	info, err := e.RequestInfo()
	if err != nil {
		return nil, nil, err
	}
	canAuth, err := e.App.CanAccessRecord(user, info, user.Collection().AuthRule)
	if !canAuth {
		if err != nil {
			return nil, nil, err
		}
		return nil, nil, errInvalidToken
	}

	return tokenRecord, user, nil
}

func deleteTokensForUser(app core.App, userID string) error {
	records, err := app.FindAllRecords(CollectionName, dbx.HashExp{"userId": userID})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return err
	}

	for _, record := range records {
		if err := app.Delete(record); err != nil {
			return err
		}
	}

	return nil
}

func listTokenExpressions(e *core.RequestEvent) []dbx.Expression {
	if !e.Auth.IsSuperuser() {
		return []dbx.Expression{dbx.HashExp{"userId": e.Auth.Id}}
	}

	userID := strings.TrimSpace(e.Request.URL.Query().Get("userId"))
	if userID == "" {
		return nil
	}

	return []dbx.Expression{dbx.HashExp{"userId": userID}}
}

func resolveTargetUserID(e *core.RequestEvent, requestedUserID string) (string, error) {
	if e.Auth.IsSuperuser() {
		if requestedUserID == "" {
			return "", e.BadRequestError("Target userId is required.", nil)
		}
		return requestedUserID, nil
	}

	if e.Auth.Collection().Name != "users" {
		return "", e.ForbiddenError("The authorized record is not allowed to manage API tokens.", nil)
	}

	if requestedUserID != "" && requestedUserID != e.Auth.Id {
		return "", e.ForbiddenError("You are not allowed to create API tokens for another user.", nil)
	}

	return e.Auth.Id, nil
}

func parseOptionalFutureDate(raw string) (types.DateTime, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return types.DateTime{}, nil
	}

	dt, err := types.ParseDateTime(raw)
	if err != nil {
		return types.DateTime{}, err
	}
	if dt.IsZero() {
		return types.DateTime{}, fmt.Errorf("expiresAt must be a valid date")
	}
	if !dt.After(types.NowDateTime()) {
		return types.DateTime{}, fmt.Errorf("expiresAt must be in the future")
	}

	return dt, nil
}

func exportToken(record *core.Record, now types.DateTime) tokenResponse {
	return tokenResponse{
		ID:         record.Id,
		UserID:     record.GetString("userId"),
		Name:       record.GetString("name"),
		AccessKey:  record.GetString("accessKey"),
		Status:     tokenStatus(record, now),
		Created:    record.GetDateTime("created").String(),
		Updated:    record.GetDateTime("updated").String(),
		ExpiresAt:  record.GetDateTime("expiresAt").String(),
		RevokedAt:  record.GetDateTime("revokedAt").String(),
		LastUsedAt: record.GetDateTime("lastUsedAt").String(),
		CreatedBy:  record.GetString("createdBy"),
		RevokedBy:  record.GetString("revokedBy"),
	}
}

func tokenStatus(record *core.Record, now types.DateTime) string {
	if !record.GetDateTime("revokedAt").IsZero() {
		return "revoked"
	}

	expiresAt := record.GetDateTime("expiresAt")
	if !expiresAt.IsZero() && !expiresAt.After(now) {
		return "expired"
	}

	return "active"
}

func actorID(auth *core.Record) string {
	if auth == nil {
		return ""
	}

	return auth.Collection().Name + ":" + auth.Id
}

func isAPITokenAuth(e *core.RequestEvent) bool {
	apiTokenAuth, _ := e.Get(requestEventKeyAPITokenAuth).(bool)
	return apiTokenAuth
}

func newTokenParts() (tokenParts, string, error) {
	access, err := randomBase36(accessKeyBytes, accessKeyLength)
	if err != nil {
		return tokenParts{}, "", err
	}

	secret, err := randomBase36(secretBytes, secretLength)
	if err != nil {
		return tokenParts{}, "", err
	}

	parts := tokenParts{Access: access, Secret: secret}
	return parts, tokenPrefix + access + "." + secret, nil
}

func randomBase36(bytesCount int, width int) (string, error) {
	buf := make([]byte, bytesCount)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}

	encoded := strings.ToLower(new(big.Int).SetBytes(buf).Text(36))
	if len(encoded) > width {
		return "", fmt.Errorf("base36 value exceeded fixed width")
	}

	return strings.Repeat("0", width-len(encoded)) + encoded, nil
}

func parseToken(raw string) (tokenParts, error) {
	if !strings.HasPrefix(raw, tokenPrefix) {
		return tokenParts{}, errInvalidToken
	}

	access, secret, ok := strings.Cut(strings.TrimPrefix(raw, tokenPrefix), ".")
	if !ok {
		return tokenParts{}, errInvalidToken
	}

	if !isLowerBase36(access, accessKeyLength) || !isLowerBase36(secret, secretLength) {
		return tokenParts{}, errInvalidToken
	}

	return tokenParts{Access: access, Secret: secret}, nil
}

func isLowerBase36(value string, expectedLength int) bool {
	if len(value) != expectedLength {
		return false
	}

	for _, r := range value {
		if (r < '0' || r > '9') && (r < 'a' || r > 'z') {
			return false
		}
	}

	return true
}

func hashSecret(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

func verifySecret(secret string, storedHash string) bool {
	stored, err := hex.DecodeString(storedHash)
	if err != nil || len(stored) != sha256.Size {
		return false
	}

	sum := sha256.Sum256([]byte(secret))
	return subtle.ConstantTimeCompare(sum[:], stored) == 1
}

func logTokenAuthFailure(app core.App, accessKey string, err error) {
	reason := "invalid"
	if errors.Is(err, errRevokedToken) {
		reason = "revoked"
	} else if errors.Is(err, errExpiredToken) {
		reason = "expired"
	}

	app.Logger().Warn(
		"api token authentication failed",
		"accessKey", accessKey,
		"reason", reason,
	)
}

func boundedQueryInt(e *core.RequestEvent, name string, fallback int, minValue int, maxValue int) int {
	raw := strings.TrimSpace(e.Request.URL.Query().Get(name))
	if raw == "" {
		return fallback
	}

	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}

	if value < minValue {
		return minValue
	}
	if value > maxValue {
		return maxValue
	}

	return value
}

func totalPages(totalItems int, perPage int) int {
	if totalItems == 0 {
		return 0
	}

	return int(math.Ceil(float64(totalItems) / float64(perPage)))
}
