package apitokens

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"github.com/pocketbase/pocketbase/tools/types"

	_ "better-pocketbase/migrations"
)

func TestCreateListAndAuthenticateWithAPIToken(t *testing.T) {
	app, handler := newTestApp(t)
	user, jwt := createUser(t, app, "api-token-user@example.com")
	item := createProtectedItem(t, app)

	status, body := requestJSON(t, handler, http.MethodPost, "/api/api-tokens", map[string]any{
		"name": "ci integration",
	}, map[string]string{"Authorization": jwt})
	if status != http.StatusCreated {
		t.Fatalf("expected create status %d, got %d: %s", http.StatusCreated, status, body)
	}

	var created createResponse
	decodeJSON(t, body, &created)
	if !strings.HasPrefix(created.Token, tokenPrefix) {
		t.Fatalf("expected token prefix %q, got %q", tokenPrefix, created.Token)
	}
	parts, err := parseToken(created.Token)
	if err != nil {
		t.Fatalf("created invalid token: %v", err)
	}
	if created.Item.AccessKey != parts.Access {
		t.Fatalf("expected access key %q, got %q", parts.Access, created.Item.AccessKey)
	}
	if created.Item.UserID != user.Id {
		t.Fatalf("expected user id %q, got %q", user.Id, created.Item.UserID)
	}
	if strings.Contains(string(body), "secretHash") {
		t.Fatalf("create response leaked secret material: %s", body)
	}

	status, body = requestJSON(t, handler, http.MethodGet, "/api/api-tokens", nil, map[string]string{"Authorization": jwt})
	if status != http.StatusOK {
		t.Fatalf("expected list status %d, got %d: %s", http.StatusOK, status, body)
	}

	var list listResponse
	decodeJSON(t, body, &list)
	if list.TotalItems != 1 || len(list.Items) != 1 {
		t.Fatalf("expected one listed token, got total=%d len=%d", list.TotalItems, len(list.Items))
	}
	if list.Items[0].AccessKey != parts.Access || list.Items[0].Status != "active" {
		t.Fatalf("unexpected listed token: %#v", list.Items[0])
	}
	if strings.Contains(string(body), created.Token) || strings.Contains(string(body), parts.Secret) {
		t.Fatalf("list response leaked token secret: %s", body)
	}

	status, body = requestJSON(t, handler, http.MethodGet, "/api/collections/api_token_items/records/"+item.Id, nil, map[string]string{
		headerAPIKey: created.Token,
	})
	if status != http.StatusOK {
		t.Fatalf("expected protected item status %d, got %d: %s", http.StatusOK, status, body)
	}
	if !strings.Contains(string(body), item.Id) {
		t.Fatalf("expected protected record response to contain %q: %s", item.Id, body)
	}

	tokenRecord, err := app.FindFirstRecordByData(CollectionName, "accessKey", parts.Access)
	if err != nil {
		t.Fatal(err)
	}
	if tokenRecord.GetDateTime("lastUsedAt").IsZero() {
		t.Fatal("expected lastUsedAt to be set after API token auth")
	}
}

func TestRejectsInvalidTokenAndAmbiguousCredentials(t *testing.T) {
	app, handler := newTestApp(t)
	_, jwt := createUser(t, app, "api-token-invalid@example.com")
	item := createProtectedItem(t, app)

	rawToken := createTokenViaAPI(t, handler, jwt, map[string]any{"name": "invalid checks"}).Token
	badToken := rawToken[:len(rawToken)-1] + "0"
	if badToken == rawToken {
		badToken = rawToken[:len(rawToken)-1] + "1"
	}

	status, body := requestJSON(t, handler, http.MethodGet, "/api/collections/api_token_items/records/"+item.Id, nil, map[string]string{
		headerAPIKey: badToken,
	})
	if status != http.StatusUnauthorized {
		t.Fatalf("expected invalid token status %d, got %d: %s", http.StatusUnauthorized, status, body)
	}

	status, body = requestJSON(t, handler, http.MethodGet, "/api/collections/api_token_items/records/"+item.Id, nil, map[string]string{
		"Authorization": jwt,
		headerAPIKey:    rawToken,
	})
	if status != http.StatusBadRequest {
		t.Fatalf("expected both-headers status %d, got %d: %s", http.StatusBadRequest, status, body)
	}
}

func TestRevokedAndExpiredTokensAreRejected(t *testing.T) {
	app, handler := newTestApp(t)
	user, jwt := createUser(t, app, "api-token-revoked@example.com")
	item := createProtectedItem(t, app)

	created := createTokenViaAPI(t, handler, jwt, map[string]any{"name": "revoke me"})

	status, body := requestJSON(t, handler, http.MethodDelete, "/api/api-tokens/"+created.Item.ID, nil, map[string]string{"Authorization": jwt})
	if status != http.StatusNoContent {
		t.Fatalf("expected revoke status %d, got %d: %s", http.StatusNoContent, status, body)
	}

	status, body = requestJSON(t, handler, http.MethodGet, "/api/collections/api_token_items/records/"+item.Id, nil, map[string]string{
		headerAPIKey: created.Token,
	})
	if status != http.StatusUnauthorized {
		t.Fatalf("expected revoked token status %d, got %d: %s", http.StatusUnauthorized, status, body)
	}

	status, body = requestJSON(t, handler, http.MethodGet, "/api/api-tokens", nil, map[string]string{"Authorization": jwt})
	if status != http.StatusOK {
		t.Fatalf("expected list status %d, got %d: %s", http.StatusOK, status, body)
	}
	var listed listResponse
	decodeJSON(t, body, &listed)
	if len(listed.Items) != 1 || listed.Items[0].Status != "revoked" {
		t.Fatalf("expected revoked status in list, got %#v", listed.Items)
	}

	expiredToken, expiredRecord := createStoredToken(t, app, user, "expired", types.NowDateTime().Add(-time.Hour))
	status, body = requestJSON(t, handler, http.MethodGet, "/api/collections/api_token_items/records/"+item.Id, nil, map[string]string{
		headerAPIKey: expiredToken,
	})
	if status != http.StatusUnauthorized {
		t.Fatalf("expected expired token status %d, got %d: %s", http.StatusUnauthorized, status, body)
	}

	status, body = requestJSON(t, handler, http.MethodGet, "/api/api-tokens", nil, map[string]string{"Authorization": jwt})
	if status != http.StatusOK {
		t.Fatalf("expected list status %d, got %d: %s", http.StatusOK, status, body)
	}
	decodeJSON(t, body, &listed)
	statuses := map[string]string{}
	for _, item := range listed.Items {
		statuses[item.ID] = item.Status
	}
	if statuses[expiredRecord.Id] != "expired" {
		t.Fatalf("expected expired status for %s, got statuses %#v", expiredRecord.Id, statuses)
	}
}

func TestManagementRequiresNormalJWTAuth(t *testing.T) {
	app, handler := newTestApp(t)
	_, jwt := createUser(t, app, "api-token-management@example.com")
	rawToken := createTokenViaAPI(t, handler, jwt, map[string]any{"name": "management"}).Token

	status, body := requestJSON(t, handler, http.MethodGet, "/api/api-tokens", nil, map[string]string{
		headerAPIKey: rawToken,
	})
	if status != http.StatusUnauthorized {
		t.Fatalf("expected api-key management status %d, got %d: %s", http.StatusUnauthorized, status, body)
	}

	status, body = requestJSON(t, handler, http.MethodGet, "/api/api-tokens", nil, nil)
	if status != http.StatusUnauthorized {
		t.Fatalf("expected anonymous management status %d, got %d: %s", http.StatusUnauthorized, status, body)
	}
}

func TestUsersAuthRuleIsEnforcedForAPITokens(t *testing.T) {
	app, handler := newTestApp(t)
	_, jwt := createUser(t, app, "api-token-auth-rule@example.com")
	item := createProtectedItem(t, app)
	rawToken := createTokenViaAPI(t, handler, jwt, map[string]any{"name": "auth rule"}).Token

	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}
	users.AuthRule = types.Pointer("verified = false")
	if err := app.Save(users); err != nil {
		t.Fatal(err)
	}

	status, body := requestJSON(t, handler, http.MethodGet, "/api/collections/api_token_items/records/"+item.Id, nil, map[string]string{
		headerAPIKey: rawToken,
	})
	if status != http.StatusUnauthorized {
		t.Fatalf("expected auth-rule failure status %d, got %d: %s", http.StatusUnauthorized, status, body)
	}
}

func TestUserDeleteRemovesAPITokens(t *testing.T) {
	app, handler := newTestApp(t)
	user, jwt := createUser(t, app, "api-token-delete@example.com")
	createTokenViaAPI(t, handler, jwt, map[string]any{"name": "delete user"})

	count, err := app.CountRecords(CollectionName, dbx.HashExp{"userId": user.Id})
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("expected one token before user delete, got %d", count)
	}

	if err := app.Delete(user); err != nil {
		t.Fatal(err)
	}

	count, err = app.CountRecords(CollectionName, dbx.HashExp{"userId": user.Id})
	if err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("expected tokens to be removed after user delete, got %d", count)
	}
}

func TestSuperuserCanManageUserTokens(t *testing.T) {
	app, handler := newTestApp(t)
	user, _ := createUser(t, app, "api-token-admin-user@example.com")
	_, superJWT := createSuperuser(t, app, "api-token-admin@example.com")

	created := createTokenViaAPI(t, handler, superJWT, map[string]any{
		"name":   "admin-created",
		"userId": user.Id,
	})
	if created.Item.UserID != user.Id {
		t.Fatalf("expected admin-created token for user %q, got %q", user.Id, created.Item.UserID)
	}
	if !strings.HasPrefix(created.Item.CreatedBy, core.CollectionNameSuperusers+":") {
		t.Fatalf("expected superuser createdBy, got %q", created.Item.CreatedBy)
	}

	status, body := requestJSON(t, handler, http.MethodGet, "/api/api-tokens?userId="+user.Id, nil, map[string]string{"Authorization": superJWT})
	if status != http.StatusOK {
		t.Fatalf("expected superuser list status %d, got %d: %s", http.StatusOK, status, body)
	}
	var listed listResponse
	decodeJSON(t, body, &listed)
	if listed.TotalItems != 1 || listed.Items[0].ID != created.Item.ID {
		t.Fatalf("expected superuser to list created token, got %#v", listed)
	}

	status, body = requestJSON(t, handler, http.MethodDelete, "/api/api-tokens/"+created.Item.ID, nil, map[string]string{"Authorization": superJWT})
	if status != http.StatusNoContent {
		t.Fatalf("expected superuser revoke status %d, got %d: %s", http.StatusNoContent, status, body)
	}
}

func newTestApp(t *testing.T) (*tests.TestApp, http.Handler) {
	t.Helper()

	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)

	Register(app)

	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}

	serveEvent := &core.ServeEvent{
		App:    app,
		Router: router,
	}
	if err := app.OnServe().Trigger(serveEvent, func(e *core.ServeEvent) error { return nil }); err != nil {
		t.Fatal(err)
	}

	handler, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}

	return app, handler
}

func createUser(t *testing.T, app core.App, email string) (*core.Record, string) {
	t.Helper()

	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}

	user := core.NewRecord(users)
	user.SetEmail(email)
	user.SetPassword("1234567890")
	user.SetVerified(true)
	if err := app.Save(user); err != nil {
		t.Fatal(err)
	}

	jwt, err := user.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}

	return user, jwt
}

func createSuperuser(t *testing.T, app core.App, email string) (*core.Record, string) {
	t.Helper()

	superusers, err := app.FindCollectionByNameOrId(core.CollectionNameSuperusers)
	if err != nil {
		t.Fatal(err)
	}

	superuser := core.NewRecord(superusers)
	superuser.SetEmail(email)
	superuser.SetPassword("1234567890")
	if err := app.Save(superuser); err != nil {
		t.Fatal(err)
	}

	jwt, err := superuser.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}

	return superuser, jwt
}

func createProtectedItem(t *testing.T, app core.App) *core.Record {
	t.Helper()

	if existing, err := app.FindCollectionByNameOrId("api_token_items"); err == nil {
		record := core.NewRecord(existing)
		record.Set("title", "protected")
		if err := app.Save(record); err != nil {
			t.Fatal(err)
		}
		return record
	}

	collection := core.NewBaseCollection("api_token_items")
	collection.ViewRule = types.Pointer("@request.context = 'apiToken' && @request.auth.id != ''")
	collection.Fields.Add(&core.TextField{Name: "title", Required: true, Max: 200})
	if err := app.Save(collection); err != nil {
		t.Fatal(err)
	}

	record := core.NewRecord(collection)
	record.Set("title", "protected")
	if err := app.Save(record); err != nil {
		t.Fatal(err)
	}

	return record
}

func createTokenViaAPI(t *testing.T, handler http.Handler, jwt string, body map[string]any) createResponse {
	t.Helper()

	status, responseBody := requestJSON(t, handler, http.MethodPost, "/api/api-tokens", body, map[string]string{"Authorization": jwt})
	if status != http.StatusCreated {
		t.Fatalf("expected create token status %d, got %d: %s", http.StatusCreated, status, responseBody)
	}

	var response createResponse
	decodeJSON(t, responseBody, &response)
	return response
}

func createStoredToken(t *testing.T, app core.App, user *core.Record, name string, expiresAt types.DateTime) (string, *core.Record) {
	t.Helper()

	parts, rawToken, err := newTokenParts()
	if err != nil {
		t.Fatal(err)
	}

	collection, err := app.FindCollectionByNameOrId(CollectionName)
	if err != nil {
		t.Fatal(err)
	}

	record := core.NewRecord(collection)
	record.Set("userId", user.Id)
	record.Set("name", name)
	record.Set("accessKey", parts.Access)
	record.Set("secretHash", hashSecret(parts.Secret))
	record.Set("createdBy", "users:"+user.Id)
	if !expiresAt.IsZero() {
		record.Set("expiresAt", expiresAt)
	}
	if err := app.Save(record); err != nil {
		t.Fatal(err)
	}

	return rawToken, record
}

func requestJSON(t *testing.T, handler http.Handler, method string, url string, body any, headers map[string]string) (int, []byte) {
	t.Helper()

	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	}

	req := httptest.NewRequest(method, url, reader)
	req.Header.Set("Content-Type", "application/json")
	for key, value := range headers {
		req.Header.Set(key, value)
	}

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	return rec.Code, rec.Body.Bytes()
}

func decodeJSON(t *testing.T, body []byte, dst any) {
	t.Helper()

	if err := json.Unmarshal(body, dst); err != nil {
		t.Fatalf("failed to decode %T from %s: %v", dst, body, err)
	}
}

func TestTokenFormatConstants(t *testing.T) {
	parts, rawToken, err := newTokenParts()
	if err != nil {
		t.Fatal(err)
	}

	expected := fmt.Sprintf("%s%s.%s", tokenPrefix, parts.Access, parts.Secret)
	if rawToken != expected {
		t.Fatalf("expected raw token %q, got %q", expected, rawToken)
	}
	if len(parts.Access) != accessKeyLength || len(parts.Secret) != secretLength {
		t.Fatalf("unexpected token part lengths: access=%d secret=%d", len(parts.Access), len(parts.Secret))
	}
}
