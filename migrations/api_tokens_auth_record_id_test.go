package migrations

import (
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/tests"
)

func TestEnsureAPITokensAuthRecordIDMigratesLegacyUserIDField(t *testing.T) {
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)

	collection, err := app.FindCollectionByNameOrId("api_tokens")
	if err != nil {
		t.Fatal(err)
	}

	field := collection.Fields.GetByName("authRecordId")
	if field == nil {
		t.Fatal("expected authRecordId field before legacy simulation")
	}
	field.SetName("userId")
	collection.RemoveIndex("idx_api_tokens_auth_record_created")
	collection.AddIndex("idx_api_tokens_user_created", false, "userId, created", "")
	if err := app.SaveNoValidate(collection); err != nil {
		t.Fatal(err)
	}

	if err := ensureAPITokensAuthRecordID(app); err != nil {
		t.Fatal(err)
	}

	collection, err = app.FindCollectionByNameOrId("api_tokens")
	if err != nil {
		t.Fatal(err)
	}

	if collection.Fields.GetByName("authRecordId") == nil {
		t.Fatal("expected authRecordId field after migration")
	}
	if collection.Fields.GetByName("userId") != nil {
		t.Fatal("did not expect legacy userId field after migration")
	}
	if collection.GetIndex("idx_api_tokens_user_created") != "" {
		t.Fatal("did not expect legacy user index after migration")
	}
	if index := collection.GetIndex("idx_api_tokens_auth_record_created"); !strings.Contains(index, "authRecordId, created") {
		t.Fatalf("expected authRecordId index after migration, got %q", index)
	}
}
