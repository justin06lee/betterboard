APP       := BetterBoard
BIN       := betterboard
BUNDLE_ID := com.justin06lee.betterboard
UNAME_S   := $(shell uname -s)

.PHONY: all build install update launch stop clean bundle-app deps icon

all: build install launch

update: all

clean:
	rm -rf out dist node_modules

# Regenerates the whole mark from its one generator: both silhouettes, every
# raster size, and the .icns. Not part of the golden path — the committed assets
# are what a build consumes.
ICON_SIZES := 1024 512 256 128 64 32 16
ICON_TMP   := out/iconset
icon:
	python3 scripts/make-icon.py assets/icon.svg --rounded
	python3 scripts/make-icon.py assets/betterboard.svg
ifeq ($(UNAME_S),Darwin)
	rm -rf $(ICON_TMP) $(ICON_TMP).iconset
	bunx electron scripts/render-icon.js assets/icon.svg $(ICON_TMP) $(ICON_SIZES)
	mkdir -p $(ICON_TMP).iconset
	cp $(ICON_TMP)/16.png   $(ICON_TMP).iconset/icon_16x16.png
	cp $(ICON_TMP)/32.png   $(ICON_TMP).iconset/icon_16x16@2x.png
	cp $(ICON_TMP)/32.png   $(ICON_TMP).iconset/icon_32x32.png
	cp $(ICON_TMP)/64.png   $(ICON_TMP).iconset/icon_32x32@2x.png
	cp $(ICON_TMP)/128.png  $(ICON_TMP).iconset/icon_128x128.png
	cp $(ICON_TMP)/256.png  $(ICON_TMP).iconset/icon_128x128@2x.png
	cp $(ICON_TMP)/256.png  $(ICON_TMP).iconset/icon_256x256.png
	cp $(ICON_TMP)/512.png  $(ICON_TMP).iconset/icon_256x256@2x.png
	cp $(ICON_TMP)/512.png  $(ICON_TMP).iconset/icon_512x512.png
	cp $(ICON_TMP)/1024.png $(ICON_TMP).iconset/icon_512x512@2x.png
	iconutil -c icns $(ICON_TMP).iconset -o assets/icon.icns
	rm -rf $(ICON_TMP) $(ICON_TMP).iconset
	@echo "assets/icon.svg, assets/betterboard.svg and assets/icon.icns regenerated"
else
	@echo "assets/icon.svg and assets/betterboard.svg regenerated (icns needs macOS)"
endif

# bun can skip electron's postinstall on a fresh platform (trust marking does
# not always trigger it), so run the downloader ourselves when dist is absent.
deps:
	bun install
	@if [ ! -d node_modules/electron/dist ]; then \
		echo "electron dist missing — running its installer"; \
		(cd node_modules/electron && bun install.js); \
	fi

# Both platforms assemble the bundle from the Electron dist that bun's electron
# postinstall already extracted — no packager dependency.

ifeq ($(UNAME_S),Darwin)
# ---------------------------------------------------------------- macOS ----
OUT_APP := out/$(APP).app
PLIST   := $(OUT_APP)/Contents/Info.plist
APP_RES := $(OUT_APP)/Contents/Resources/app

# Ad-hoc signing is required for the modified bundle to launch on Apple Silicon.
build: deps
	bun run build
	rm -rf out
	mkdir -p out
	ditto node_modules/electron/dist/Electron.app "$(OUT_APP)"
	rm "$(OUT_APP)/Contents/Resources/default_app.asar"
	$(MAKE) bundle-app APP_RES="$(APP_RES)"
	mv "$(OUT_APP)/Contents/MacOS/Electron" "$(OUT_APP)/Contents/MacOS/$(APP)"
	/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable $(APP)" "$(PLIST)"
	/usr/libexec/PlistBuddy -c "Set :CFBundleName $(APP)" "$(PLIST)"
	/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $(BUNDLE_ID)" "$(PLIST)"
	/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $(APP)" "$(PLIST)" || \
		/usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string $(APP)" "$(PLIST)"
	cp assets/icon.icns "$(OUT_APP)/Contents/Resources/icon.icns"
	rm -f "$(OUT_APP)/Contents/Resources/electron.icns"
	/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile icon" "$(PLIST)"
	codesign --force --deep --sign - "$(OUT_APP)" 2>/dev/null

install: stop
	rm -rf /Applications/$(APP).app
	cp -R "$(OUT_APP)" /Applications/

launch:
	open /Applications/$(APP).app

stop:
	-pkill -x $(APP) 2>/dev/null || true

else
# ---------------------------------------------------------------- Linux ----
PREFIX   := $(HOME)/.local
OPT_DIR  := $(PREFIX)/opt/$(BIN)
BIN_LINK := $(PREFIX)/bin/$(BIN)
OUT_DIR  := out/$(BIN)
APP_RES  := $(OUT_DIR)/resources/app

build: deps
	bun run build
	rm -rf out
	mkdir -p $(OUT_DIR)
	cp -a node_modules/electron/dist/. $(OUT_DIR)/
	rm $(OUT_DIR)/resources/default_app.asar
	$(MAKE) bundle-app APP_RES="$(APP_RES)"
	mv $(OUT_DIR)/electron $(OUT_DIR)/$(BIN)

install: stop
	rm -rf $(OPT_DIR)
	mkdir -p $(PREFIX)/opt $(PREFIX)/bin \
		$(PREFIX)/share/applications $(PREFIX)/share/icons/hicolor/scalable/apps
	cp -a $(OUT_DIR) $(OPT_DIR)
	ln -sf $(OPT_DIR)/$(BIN) $(BIN_LINK)
	cp assets/icon.svg $(PREFIX)/share/icons/hicolor/scalable/apps/$(BIN).svg
	printf '[Desktop Entry]\nType=Application\nName=$(APP)\nComment=Infinite whiteboard for pen displays\nExec=$(BIN_LINK)\nIcon=$(BIN)\nTerminal=false\nCategories=Graphics;Office;\nStartupWMClass=$(BIN)\n' \
		> $(PREFIX)/share/applications/$(BIN).desktop
	-update-desktop-database $(PREFIX)/share/applications 2>/dev/null || true
# Chromium's SUID sandbox: Ubuntu 24.04+ restricts unprivileged user
# namespaces, so chrome-sandbox must be root-owned and setuid to launch.
	@if [ "$$(stat -c '%u %a' $(OPT_DIR)/chrome-sandbox 2>/dev/null)" != "0 4755" ]; then \
		echo "chrome-sandbox needs a one-time root setuid:"; \
		sudo chown root:root $(OPT_DIR)/chrome-sandbox && sudo chmod 4755 $(OPT_DIR)/chrome-sandbox \
			|| echo "warning: setuid failed — if launch fails, rerun 'make install' with sudo available"; \
	fi
	@case ":$$PATH:" in \
		*":$(PREFIX)/bin:"*) ;; \
		*) echo "note: $(PREFIX)/bin is not on your PATH; add it to run '$(BIN)' by name" ;; \
	esac

launch:
	(setsid $(BIN_LINK) >/dev/null 2>&1 &)

stop:
	-pkill -x $(BIN) 2>/dev/null || true

endif

# Shared: copy the app sources into the bundle's resources/app directory.
# Whole directories rather than named files — listing them by hand meant a new
# main-process module could be added and silently left out of the bundle.
bundle-app:
	mkdir -p "$(APP_RES)/src/main" "$(APP_RES)/dist"
	cp package.json "$(APP_RES)/"
	cp -R src/main/. "$(APP_RES)/src/main/"
	cp -R dist/. "$(APP_RES)/dist/"
	@node scripts/check-bundle.js "$(APP_RES)"
