.PHONY: dev-backend dev-frontend dev build install install-backend install-frontend \
        bundle-backend package dev-sidecar-stub test

# A virtual environment of your own; `python -m venv .venv` makes this one.
VENV ?= .venv
TARGET_TRIPLE := $(shell rustc -vV | sed -n 's/host: //p')
SIDECAR_DIR := frontend/src-tauri/binaries
SIDECAR_BIN := $(SIDECAR_DIR)/interview-coach-backend-$(TARGET_TRIPLE)

install-backend:
	$(VENV)/bin/pip install -r backend/requirements.txt -c backend/constraints.txt

install-frontend:
	cd frontend && npm ci

install: install-backend install-frontend

# The FastAPI backend, from source, on port 8000
dev-backend:
	$(VENV)/bin/uvicorn backend.main:app --reload --port 8000

# The Vite dev server only (no Tauri window), on port 1420
dev-frontend:
	cd frontend && npm run dev

# A stub sidecar so Tauri's build check passes; INTERVIEW_COACH_SKIP_SIDECAR stops it running.
dev-sidecar-stub:
	@mkdir -p $(SIDECAR_DIR)
	@if [ ! -f "$(SIDECAR_BIN)" ] && [ ! -f "$(SIDECAR_BIN).exe" ]; then \
	  case "$(TARGET_TRIPLE)" in \
	    *windows*) cp /c/Windows/System32/cmd.exe "$(SIDECAR_BIN).exe" ;; \
	    *) printf '#!/bin/sh\necho "[dev stub] run make dev-backend" >&2\nexit 0\n' > $(SIDECAR_BIN); \
	       chmod +x $(SIDECAR_BIN) ;; \
	  esac; \
	  echo "  stub sidecar at $(SIDECAR_BIN)"; \
	fi

# The desktop window; run `make dev-backend` in another terminal first
dev: dev-sidecar-stub
	cd frontend && INTERVIEW_COACH_SKIP_SIDECAR=1 npm run tauri dev

# The backend as a PyInstaller folder build (dist/interview-coach-backend/)
bundle-backend:
	$(VENV)/bin/pyinstaller backend/build/interview-coach-backend.spec --clean --noconfirm

# The bundled backend, copied beside the app as its sidecar
package: bundle-backend
	mkdir -p $(SIDECAR_DIR)
	@test -d dist/interview-coach-backend/_internal \
	  || { echo "no _internal beside the backend exe: is the spec still a onedir build?"; exit 1; }
	cp dist/interview-coach-backend/interview-coach-backend $(SIDECAR_BIN)

# Installers, in frontend/src-tauri/target/release/bundle/
build: package
	cd frontend && npm run tauri build

test:
	$(VENV)/bin/python -m pytest -q backend/tests
	cd frontend && npx tsc --noEmit && npx vitest run
