# Denuncia Rápida 🚗

**Denunciá autos mal estacionados en la Ciudad de Buenos Aires con una sola foto.**
Arrastrás la imagen, la app habla sola con el bot oficial de BA Ciudad (Boti) por WhatsApp y te devuelve el número de trámite. Cero clics en el medio.

> Hecho para vecinos que quieren una ciudad mejor ordenada. Gratis y de código abierto.

---

## ✨ Qué hace

1. Arrastrás **una foto** del auto/moto en infracción.
2. La app, **todo en tu compu** (sin enviar nada a la nube):
   - lee el GPS y la fecha de la foto,
   - busca la dirección,
   - detecta y lee la **patente** con IA local,
   - clasifica el tipo de infracción.
3. Vos revisás los datos y le das **Enviar**.
4. La app conversa con Boti, inicia sesión en miBA y completa todo el trámite.
5. **Recibís el número de trámite** 🎉 — queda guardado en tu historial.

---

## ⚠️ Antes de empezar

- Usa la librería `baileys` para hablar por WhatsApp (no es oficial, va contra los TOS de WhatsApp). **Usá un número secundario** si te preocupa, aunque el riesgo es bajo: solo le escribe a un bot del gobierno, pocos mensajes por denuncia.
- Necesitás una cuenta de **miBA** (Mi Buenos Aires).
- La IA corre **localmente** con [Ollama](https://ollama.com) — gratis, privado, sin claves de API.

---

## 🛠️ Requisitos

- **macOS** (probado) · Node.js 18+
- [Ollama](https://ollama.com) con un modelo de visión:
  ```bash
  ollama pull gemma4:e4b
  ```
  *(La detección de patente baja además un modelo chico (~150MB) la primera vez, automáticamente.)*
- Una cuenta de WhatsApp y una de miBA.

---

## 🚀 Instalación

```bash
git clone https://github.com/hernaezTlon/denuncia-rapida.git
cd denuncia-rapida
npm install
ollama pull gemma4:e4b      # una sola vez

npm start                   # abre la app
```

**Opcional — instalar como app de macOS** (aparece en Spotlight y el Dock con su ícono):
```bash
npm run install-app         # crea "~/Applications/Denuncia Rápida.app"
```

---

## 📱 Primer uso (se hace una sola vez)

1. **Abrí la app.** Arriba a la derecha vas a ver el estado de WhatsApp, IA local y miBA.
2. **Escaneá el QR** de WhatsApp con tu celular (como WhatsApp Web). La sesión queda guardada.
3. **Guardá tus credenciales de miBA**: click en **⚙ miBA**, poné usuario y contraseña, **Guardar**.
   - Se guardan **encriptadas en el llavero del sistema** — nunca en texto plano, nunca se suben a ningún lado.
   - Después de esto, cuando la sesión de miBA expire, la app entra sola.

Listo. A partir de acá: **arrastrás una foto y la app hace el resto.**

---

## 📱 Desde el celular (cero clics en la compu)

Con la app corriendo en tu Mac, usá el chat **"Mensaje para mí"** de WhatsApp como control remoto:

1. Sacá la foto del vehículo y **compartila a tu propio chat** de WhatsApp.
2. Opcional, en el mismo chat:
   - **Ubicación** 📍 → se convierte en la dirección automáticamente.
   - **Texto** → si parece dirección ("Libertador y Olleros") la usa como dirección; si no, como descripción.
   - **Audio** 🎙 → se transcribe si tenés `whisper-cpp` instalado (`brew install whisper-cpp`).
   - **Caption** en la foto → mismo ruteo que el texto.
3. La app lee la patente (IA local + respaldo online), clasifica la infracción, entra a miBA sola y habla con Boti.
4. **Te responde en el mismo chat con el número de trámite.** ✅

Si falta la dirección, te la pide por el chat — un solo mensaje y sigue sola. Si la foto llegó sin fecha (WhatsApp la borra en las imágenes), te pregunta la hora: respondé `09:30` o `ahora`. Si no hay IA local para clasificar la infracción, te pregunta cuál es: respondé la letra (A senda peatonal, B rampa, C doble fila, D garage, E vereda, F parada de colectivo, G ochava) o escribí qué pasa. La descripción que va a Boti es una oración concreta con la patente y la falta — un texto genérico hizo que desestimaran una denuncia ("las fotos no muestran la falta"). Guarda la denuncia a medias hasta 24 horas y te recuerda una vez a los 30 minutos.
También hay un daemon sin UI: `node scripts/inbox-daemon.js`.

### Qué hace sola cuando algo falla

- **Boti se cuelga o corta**: reintenta la conversación hasta 3 veces (30 s y 90 s de espera). Solo te avisa si falla las tres.
- **No lee bien la patente**: si Boti pide la patente por texto, manda igual la mejor lectura que tenga. Boti la confirma con su propio OCR.
- **Boti lee otra patente** (un auto de fondo): le dice que no hasta 2 veces. Después te pide una foto de cerca de la patente y con esa reintenta sola.
- **Dos fotos, dos autos**: si la segunda foto tiene otra patente, arma una segunda denuncia y la manda cuando termina la primera. Si es la misma patente (o no se lee), la usa como close-up.
- **Ollama apagado o sin modelo**: lo arranca y descarga el modelo sola. Lo revisa cada 10 minutos.

### La receta de cero interacciones extra

WhatsApp **borra el GPS** de las fotos enviadas como imagen. Si la mandás como **documento**, el GPS y la fecha sobreviven y no te pregunta nada:

> Compartir → WhatsApp → tu chat → clip 📎 → **Documento** → elegir la foto.

Con eso la app resuelve **dirección, fecha y hora reales de la foto** sola (usa la fecha EXIF, no el momento del envío — podés mandar la foto horas después). La dirección sale del geocoder oficial de la Ciudad (USIG), con altura y los nombres de calle que usa Boti. Si la mandás como imagen normal, solo te va a pedir la ubicación: un toque en 📍 y sigue.

### Un toque, cero preguntas: atajo de iOS + iCloud Drive

WhatsApp borra la metadata de las fotos enviadas como imagen. La vía sin fricción es **no pasar por WhatsApp para la foto**: un atajo en la hoja de compartir guarda el original (con fecha, hora y GPS) en `iCloud Drive/Denuncias`, y la app en la Mac lo levanta sola. Te sigue respondiendo por el chat "Mensaje para mí" con el número de trámite.

Atajo listo para instalar: abrí [`Denunciar.shortcut`](Denunciar.shortcut) en el iPhone y tocá **Añadir atajo** (está firmado con `shortcuts sign --mode anyone`). **Después de añadirlo, abrilo una vez y en la acción "Guardar archivo" elegí la carpeta `iCloud Drive/Denuncias`** (un archivo `.shortcut` no puede traer esa carpeta elegida; si la dejás en "Shortcuts" la foto va a `iCloud Drive/Shortcuts` y nadie la ve). O crealo a mano (app Atajos → + → detalles → "Mostrar en hoja de compartir", tipo: Imágenes):

1. **Recibir** `Imágenes` de la hoja de compartir
2. **Convertir imagen** → formato `JPEG`, calidad máxima, **Conservar metadatos: SÍ**
3. **Guardar archivo** → destino: carpeta `iCloud Drive/Denuncias` (elegila en el selector), **Subruta vacía**, **Preguntar dónde guardar: NO**
4. (opcional) **Mostrar notificación** "Denuncia enviada 📷"

Nombralo **Denunciar**. Uso: Fotos → Compartir → **Denunciar**. Listo.

La app vigila esa carpeta (`DENUNCIA_FOLDER` para cambiarla), espera a que iCloud termine de bajar el archivo y lo mueve a `Denuncias/procesadas/`.

### Siempre encendida (auto-arranque)

Para que el flujo del celular funcione sin abrir nada en la Mac:

```bash
npm run install-autostart
```

Crea un LaunchAgent: la app arranca sola al iniciar sesión y se relanza si se cierra. La Mac solo tiene que estar despierta. Se quita con `npm run uninstall-autostart`.
Si la Mac estaba dormida cuando mandaste la foto, la denuncia sale sola al despertarse (WhatsApp entrega los mensajes pendientes).

## 🧭 Cómo usarla

1. Arrastrá la foto a la zona grande (o click para elegir). Con una sola foto alcanza.
2. Esperá unos segundos: aparece la **patente detectada** (estilo chapa MERCOSUR), la dirección, la fecha y el tipo de infracción.
3. Revisá que esté todo bien. Si la patente que leyó la IA no es la del vehículo que querés denunciar, cambiá la foto.
4. **Enviar denuncia.** Mirá la conversación con Boti en vivo a la derecha.
5. Cuando termina, te muestra el **número de trámite** con un botón para copiarlo. Queda en **Historial** (▤ arriba a la derecha).

---

## 🔒 Privacidad

- Las fotos, el OCR y la clasificación se procesan **100% en tu máquina** (Ollama local).
- Tu sesión de WhatsApp y tus credenciales de miBA viven solo en tu compu (`~/.denuncia-rapida-session/` y el llavero del sistema).
- No hay servidores, ni analytics, ni claves de API. El único tráfico de red es: WhatsApp, miBA, el geocoder oficial de la Ciudad (USIG) y OpenStreetMap como respaldo (para la dirección).

---

## ❤️ Apoyar el proyecto

Si te sirve, podés bancarlo en **[GitHub Sponsors](https://github.com/sponsors/hernaezTlon)** (también está el botón **♥ Apoyar** dentro de la app). Es gratis y siempre lo va a ser — el apoyo ayuda a mantenerlo.

---

## 🧰 Para desarrolladores

```bash
npm run dev          # modo desarrollo (DevTools con Cmd+Opt+I, o OPEN_DEVTOOLS=1 npm run dev)
npm test             # 96 tests (node --test)
npm run install-app  # wrapper .app de macOS vía osacompile
```

### Arquitectura

```
src/
├── main/
│   ├── main.js          # proceso principal Electron + IPC
│   └── preload.js       # puente seguro (contextIsolation)
├── renderer/
│   ├── index.html       # UI (stepper, status bar, chapa, chat, historial)
│   ├── styles.css        # estética "panel de despacho"
│   └── app.js
└── lib/
    ├── photoProcessor.js   # EXIF + geocoding (USIG oficial → Nominatim)
    ├── ollamaSupervisor.js # arranca Ollama y baja el modelo si faltan
    ├── whatsappBot.js      # máquina de estados de la conversación con Boti
    ├── inboxWatcher.js     # chat "Mensaje para mí": cola de denuncias, reintentos
    ├── folderWatcher.js    # iCloud Drive/Denuncias → misma cola, con EXIF intacto
    ├── violationText.js    # menú de infracciones + oración descriptiva para Boti
    ├── aiAssistant.js      # Ollama: clasificación, OCR de patente, desambiguación
    ├── mibaAutoLogin.js    # ventana de login miBA + auto-fill
    ├── mibaCredentials.js  # almacenamiento encriptado (safeStorage)
    ├── reportValidation.js # validación soft (repara en vez de bloquear)
    └── reportHistory.js    # persiste cada denuncia en disco
assets/icon.svg            # ícono fuente · build/icon.icns para macOS
```

### Cómo funciona el OCR de patente

Dos etapas, todo local: un detector **YOLOS** (ONNX, vía `@huggingface/transformers`) recorta la chapa, y `gemma4:e4b` lee el recorte enfocado. Rápido (~2s) y preciso, sin modelos gigantes.

### Variables de entorno

| Variable | Default | Para qué |
|---|---|---|
| `OLLAMA_URL` | `http://localhost:11434` | endpoint Ollama |
| `OLLAMA_MODEL` | `gemma4:e4b` | modelo de visión |
| `OLLAMA_OCR_MODEL` | `gemma4:e4b` | modelo para OCR de patente |
| `OPEN_DEVTOOLS` | — | `1` para abrir DevTools al arrancar |

---

## 📦 Distribución (.dmg)

Ver [`DISTRIBUTION.md`](DISTRIBUTION.md). Resumen: en macOS reciente hay un problema conocido de firma de código con apps Electron empaquetadas; el camino confiable hoy es **clonar + `npm install` + `npm run install-app`**. El empaquetado `.dmg` está configurado pero requiere resolver la firma (cert de Apple Developer).

---

## 📄 Licencia

MIT — usalo, forkealo, mejoralo. Bajo tu propia responsabilidad.
