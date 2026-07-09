package migrations

import (
	"database/sql"
	"errors"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		return ensureAPITokensAuthRecordID(app)
	}, nil)
}

func ensureAPITokensAuthRecordID(app core.App) error {
	collection, err := app.FindCollectionByNameOrId("api_tokens")
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return err
	}

	if existing := collection.Fields.GetByName("authRecordId"); existing != nil {
		ensureAPITokenOwnerField(existing)
	} else if legacy := collection.Fields.GetByName("userId"); legacy != nil {
		legacy.SetName("authRecordId")
		ensureAPITokenOwnerField(legacy)
	} else {
		collection.Fields.Add(apiTokenOwnerField())
	}

	collection.RemoveIndex("idx_api_tokens_user_created")
	collection.AddIndex("idx_api_tokens_auth_record_created", false, "authRecordId, created", "")

	return app.SaveNoValidate(collection)
}

func apiTokenOwnerField() *core.TextField {
	return &core.TextField{
		Name:     "authRecordId",
		System:   true,
		Required: true,
		Min:      1,
		Max:      255,
	}
}

func ensureAPITokenOwnerField(field core.Field) {
	field.SetSystem(true)

	textField, ok := field.(*core.TextField)
	if !ok {
		return
	}

	textField.Required = true
	textField.Min = 1
	textField.Max = 255
}
