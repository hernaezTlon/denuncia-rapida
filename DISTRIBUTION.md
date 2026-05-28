# Distribución

Cómo empaquetar y compartir Denuncia Rápida.

## TL;DR

- **Para vos / instalación local:** `npm run install-app` (wrapper `.app` vía osacompile). Funciona siempre, sin firma.
- **Para compartir con otros técnicos:** que clonen + `npm install` + `npm run install-app`.
- **Para un `.dmg` distribuible:** configurado con `electron-builder` (`npm run dist`), pero requiere resolver la firma de código (ver abajo).

---

## Opción A — Instalación local (recomendada hoy)

```bash
npm install
ollama pull gemma4:e4b
npm run install-app
```

Crea `~/Applications/Denuncia Rápida.app` con el ícono propio. Usa `osacompile` (AppleScript) que corre con permisos completos del usuario, evitando el sandbox de macOS que bloquea apps `.app` comunes al leer archivos de `~/Documents`.

**Limitación:** no es un artefacto que puedas mandar por mail — apunta al checkout local del repo. Para otra persona, tiene que clonar el repo.

---

## Opción B — `.dmg` con electron-builder

Configurado en `package.json` (`build`). Para construir:

```bash
npm install --save-dev electron-builder
npm run icon     # asegura build/icon.icns
npm run dist     # genera dist/*.dmg y dist/*.zip (arm64 + x64)
```

### El problema de la firma en macOS reciente

En Apple Silicon, macOS **exige** que todo binario esté firmado (al menos ad-hoc). Las apps Electron empaquetadas sin firmar pueden crashear al arrancar (`EXC_BREAKPOINT` en V8). La config usa `"identity": null`, que deja que electron-builder haga **firma ad-hoc** automáticamente — suele alcanzar para correr localmente.

Si el `.dmg` resultante crashea:

1. **Firma ad-hoc manual** del `.app` dentro del `.dmg`:
   ```bash
   codesign --force --deep --sign - "dist/mac-arm64/Denuncia Rápida.app"
   ```
2. **Quitar quarantine** en la máquina destino:
   ```bash
   xattr -cr "/Applications/Denuncia Rápida.app"
   ```
3. Abrir con **click derecho → Abrir** la primera vez (Gatekeeper).

### Para distribución "de verdad" (sin fricción para el usuario)

Hace falta una **Apple Developer ID** (US$99/año) para firmar + notarizar:

```jsonc
// package.json -> build.mac
"identity": "Developer ID Application: Tu Nombre (TEAMID)",
"notarize": { "teamId": "TEAMID" }
```

Con eso el `.dmg` se abre con doble click sin warnings. Es el paso pendiente para una release masiva real.

---

## Ícono

El ícono se genera desde `assets/icon.svg`:

```bash
npm run icon   # -> assets/icon.png (1024) + build/icon.icns
```

`assets/icon.png` lo usa la ventana y el Dock en dev; `build/icon.icns` lo usa el `.app` empaquetado y `install-app.sh`.
