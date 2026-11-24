.PHONY: all build test clean run-dialer run-simulator docker-up docker-down

all: test build

build:
	@echo "Building binaries..."
	go build -o bin/dialer cmd/dialer/main.go
	go build -o bin/simulator cmd/simulator/main.go

test:
	@echo "Running all unit and integration tests..."
	go test -v -race -timeout 120s ./...

run-dialer:
	go run cmd/dialer/main.go

run-simulator:
	go run cmd/simulator/main.go --all

run-failures:
	go run cmd/simulator/main.go --failures

run-scenarios:
	go run cmd/simulator/main.go --scenarios

run-load:
	go run cmd/simulator/main.go --load

docker-up:
	docker compose up -d postgres dialer

docker-down:
	docker compose down -v

docker-sim:
	docker compose --profile sim run --rm simulator

clean:
	rm -rf bin/
