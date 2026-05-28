# Denuncia Rápida 🚗

Aplicación de escritorio que **automatiza denuncias de mal estacionamiento** en la Ciudad de Buenos Aires usando el bot oficial de BA Ciudad en WhatsApp.

**Goal:** arrastrás una foto, la app se ocupa de todo.

## ⚡ Cómo funciona

1. **Arrastrás una foto** del auto en infracción
2. La app:
   - Lee GPS, fecha y hora de los metadatos EXIF
   - Geocodifica la ubicación con OpenStreetMap (Nominatim)
   - Clasifica el tipo de infracción con IA local (Ollama)
   - Si la dirección está incompleta, intenta repararla con IA
   - Conecta automáticamente al bot de BA Ciudad por WhatsApp
   - Abre la ventana de login miBA (se completa una sola vez gracias a cookies persistentes)
   - Conversa con el bot hasta recibir el número de trámite
3. **Recibís el número de trámite** 🎉

No hay clics intermedios entre subir la foto y recibir el ticket.

## ⚠️ Antes de usar

- Usa `baileys` (cliente WhatsApp no-oficial). Va contra los TOS de WhatsApp. Usá un número secundario.
- Necesitás una cuenta de **miBA** (Mi Buenos Aires) — la app abre una ventana para que inicies sesión una sola vez.
- Necesitás **Ollama** corriendo localmente con un modelo de visión (el modelo es gratis, corre 100% offline).

## 🛠️ Requisitos

- Node.js 18+
- [Ollama](https://ollama.com) instalado, con un modelo de visión:
  ```bash
  ollama pull gemma4:e4b
  ```
  *(O cualquier modelo vision-capable. Configurable con `OLLAMA_MODEL`.)*
- Una cuenta de WhatsApp (preferentemente secundaria)
- Una cuenta de miBA

## 🚀 Instalación

```bash
npm install
ollama pull gemma4:e4b   # ~9GB, una sola vez
npm run dev              # con DevTools abierta
# o
npm start                # producción
```

## 📱 Primer uso

1. Abrí la app. Verifica que Ollama esté disponible (sale en el panel de log).
2. Escaneá el QR de WhatsApp con tu celular. La sesión queda guardada en `~/.denuncia-rapida-session/` por semanas.
3. Arrastrá la primera foto. La app inicia la conversación con el bot.
4. Cuando el bot pida login miBA, se abrirá una ventana adentro de la app. Iniciá sesión una vez — las cookies persisten para próximas denuncias.
5. La app sigue automáticamente hasta el ticket.

## 📸 Sobre las fotos

- **Con una foto alcanza.** Si arrastrás solo una, la app la usa tanto para el slot "contexto" como para "patente".
- **GPS habilitado.** Sin coordenadas EXIF, la dirección no se autocompletará y la IA tampoco podrá ayudar.
- **Foto reciente.** El bot acepta fotos viejas pero suele rechazarlas — apuntá a < 14 días.
- **Patente visible.** El bot OCRea la patente automáticamente; si no se ve, te pedirá rehacer.

## 🤖 Cómo interviene la IA

El modelo Ollama local hace tres cosas, todas opcionales (la app funciona sin él, solo con menos automatización):

| Cuándo | Qué hace |
|---|---|
| Al subir foto | Clasifica el tipo de infracción (8 categorías) viendo la imagen |
| Si Nominatim falla o devuelve dirección incompleta | Intenta inferir la dirección desde la foto + GPS |
| Si el bot manda un mensaje inesperado | Lee el contexto y decide qué responder (max 5 intervenciones por denuncia) |

Todo corre en tu máquina. Cero llamadas a APIs externas, cero costo.

## 🗂️ Estructura

```
src/
├── main/
│   ├── main.js          # Electron main process + IPC
│   └── preload.js       # Bridge a la UI con contextIsolation
├── renderer/
│   ├── index.html       # UI
│   ├── styles.css
│   └── app.js           # Lógica + auto-submit
└── lib/
    ├── photoProcessor.js   # EXIF + Nominatim
    ├── whatsappBot.js      # State machine + AI disambiguation
    ├── reportValidation.js # Validación soft (auto-repara)
    ├── reportHistory.js    # Persiste cada denuncia en disco
    ├── aiAssistant.js      # Wrapper Ollama (clasificación + reparación)
    └── mibaAutoLogin.js    # BrowserWindow con sesión persistente
test/
└── *.test.js               # 37 tests
scripts/
└── install-app.sh           # Wrapper .app para macOS (osacompile)
```

## 🔧 Desarrollo

```bash
npm run dev          # Electron con DevTools
npm test             # 37 tests
npm run install-app  # Crea ~/Applications/Denuncia Rápida.app (macOS)
```

Configuración por variables de entorno:

| Variable | Default | Para qué |
|---|---|---|
| `OLLAMA_URL` | `http://localhost:11434` | Endpoint Ollama |
| `OLLAMA_MODEL` | `gemma4:e4b` | Modelo de visión |
| `DENUNCIA_REPORTS_DIR` | `~/.denuncia-rapida-session/reports` | Dónde se guardan los logs |

Las denuncias enviadas (éxito o falla) quedan en `~/.denuncia-rapida-session/reports/<fecha>.json` con la transcripción completa.

## 📝 Roadmap

- [x] Migración a `baileys` v7
- [x] Modo single-photo (una foto va a los dos slots)
- [x] Clasificación IA del tipo de infracción
- [x] Reparación IA de direcciones cuando Nominatim falla
- [x] Auto-login miBA con cookies persistentes
- [x] Validación soft (nunca bloquea, repara y avisa)
- [x] Disambiguación IA cuando el bot manda algo inesperado
- [x] Log persistente de denuncias
- [ ] UI de historial (leer los JSON guardados)
- [ ] OCR local de patentes (Tesseract) para cross-check con el bot
- [ ] Wizard de primer arranque

## 📄 Licencia

MIT.

---

Hecho para vecinos de Buenos Aires que quieren una ciudad mejor ordenada.
