package main

import (
	"log"

	"better-pocketbase/internal/apitokens"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/plugins/migratecmd"

	_ "better-pocketbase/migrations"
)

func main() {
	app := pocketbase.New()
	migratecmd.MustRegister(app, app.RootCmd, migratecmd.Config{})
	apitokens.Register(app)

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}
