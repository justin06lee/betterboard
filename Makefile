APP       := BetterBoard
BUNDLE_ID := com.justin06lee.betterboard
OUT_APP   := out/$(APP).app
PLIST     := $(OUT_APP)/Contents/Info.plist
APP_RES   := $(OUT_APP)/Contents/Resources/app

.PHONY: all build install update launch stop clean

all: build install launch

# The bundle is assembled from the Electron.app that bun's electron postinstall
# already extracted — no packager dependency. Ad-hoc signing is required for
# the modified bundle to launch on Apple Silicon.
build:
	bun install
	bun run build
	rm -rf out
	mkdir -p out
	ditto node_modules/electron/dist/Electron.app "$(OUT_APP)"
	rm "$(OUT_APP)/Contents/Resources/default_app.asar"
	mkdir -p "$(APP_RES)/src/main" "$(APP_RES)/dist"
	cp package.json "$(APP_RES)/"
	cp src/main/main.js src/main/preload.js "$(APP_RES)/src/main/"
	cp dist/index.html dist/style.css dist/renderer.js "$(APP_RES)/dist/"
	mv "$(OUT_APP)/Contents/MacOS/Electron" "$(OUT_APP)/Contents/MacOS/$(APP)"
	/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable $(APP)" "$(PLIST)"
	/usr/libexec/PlistBuddy -c "Set :CFBundleName $(APP)" "$(PLIST)"
	/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $(BUNDLE_ID)" "$(PLIST)"
	/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $(APP)" "$(PLIST)" || \
		/usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string $(APP)" "$(PLIST)"
	codesign --force --deep --sign - "$(OUT_APP)" 2>/dev/null

install: stop
	rm -rf /Applications/$(APP).app
	cp -R "$(OUT_APP)" /Applications/

update: all

launch:
	open /Applications/$(APP).app

stop:
	-pkill -x $(APP) 2>/dev/null || true

clean:
	rm -rf out dist node_modules
