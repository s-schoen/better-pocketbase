package migrations

import (
	"database/sql"
	"errors"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		if _, err := app.FindCollectionByNameOrId("api_tokens"); err == nil {
			return nil
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}

		collection := core.NewBaseCollection("api_tokens")
		collection.System = true

		collection.Fields.Add(
			&core.AutodateField{
				Name:     "created",
				System:   true,
				OnCreate: true,
			},
			&core.AutodateField{
				Name:     "updated",
				System:   true,
				OnCreate: true,
				OnUpdate: true,
			},
			&core.TextField{
				Name:     "userId",
				System:   true,
				Required: true,
				Min:      1,
				Max:      255,
			},
			&core.TextField{
				Name:     "name",
				System:   true,
				Required: true,
				Min:      1,
				Max:      200,
			},
			&core.TextField{
				Name:     "accessKey",
				System:   true,
				Required: true,
				Min:      25,
				Max:      25,
				Pattern:  "^[0-9a-z]{25}$",
			},
			&core.TextField{
				Name:     "secretHash",
				System:   true,
				Hidden:   true,
				Required: true,
				Min:      64,
				Max:      64,
				Pattern:  "^[0-9a-f]{64}$",
			},
			&core.DateField{
				Name:   "expiresAt",
				System: true,
			},
			&core.DateField{
				Name:   "revokedAt",
				System: true,
			},
			&core.DateField{
				Name:   "lastUsedAt",
				System: true,
			},
			&core.TextField{
				Name:   "createdBy",
				System: true,
				Max:    255,
			},
			&core.TextField{
				Name:   "revokedBy",
				System: true,
				Max:    255,
			},
		)

		collection.AddIndex("idx_api_tokens_access_key", true, "accessKey", "")
		collection.AddIndex("idx_api_tokens_user_created", false, "userId, created", "")

		return app.Save(collection)
	}, nil)
}
