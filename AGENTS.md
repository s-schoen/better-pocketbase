# AGENTS.md

## Project Context

This is a minimal Go project for extending PocketBase using the official Go extension API with some custom features.

## Useful Commands

This project uses Taskfile. The binary is available as `go-task`:

- `go-task build`: builds the server binary to `bin/better-pocketbase`
- `go-task test`: runs `go test -buildvcs=false ./...`
- `go-task lint`: runs `golangci-lint run ./...`
- `go-task run`: starts the PocketBase server with `go run -buildvcs=false . serve`
- `go-task clean`: removes generated build artifacts

To pass PocketBase CLI flags through the run task, use `--`:

```sh
go-task run -- --help
```

## PocketBase Extensions

You can find the official documentation for PocketBase extensions here: https://pocketbase.io/docs/go-overview/
Make sure to always implement features using the official API if possible