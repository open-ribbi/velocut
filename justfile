# Velocut task runner. `just` is optional — every recipe is a one-liner you can
# also run by hand (or via the `web/` npm scripts). See README for context.
#
#   just            # list recipes
#   just setup      # one-time: rust wasm target + wasm-pack
#   just build-wasm # compile the canonical Rust engine into the editor's public/wasm
#   just build      # build-wasm, then the web app
#   just dev        # run the editor dev server
#   just test       # both engines against the shared golden vectors

_default:
    @just --list

# One-time toolchain for building the canonical WASM engine.
setup:
    rustup target add wasm32-unknown-unknown
    cargo install wasm-pack

# Compile crates/velocut-wasm → web/apps/editor/public/wasm (gitignored product).
build-wasm:
    wasm-pack build crates/velocut-wasm --target web --release --out-dir web/apps/editor/public/wasm

# Full build: canonical WASM engine, then the web app (tsc -b && vite build).
build: build-wasm
    npm --prefix web run build

# Editor dev server (TS engine unless build-wasm has run).
dev:
    npm --prefix web run dev

# Both engines against protocol/vectors/*.json (the behavioral contract).
test:
    cargo test
    npm --prefix web test
