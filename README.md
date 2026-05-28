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
- No hay servidores, ni analytics, ni claves de API. El único tráfico de red es: WhatsApp, miBA y OpenStreetMap (para la dirección).

---

## ❤️ Apoyar el proyecto

Si te sirve, podés bancarlo en **[GitHub Sponsors](https://github.com/sponsors/hernaezTlon)** (también está el botón **♥ Apoyar** dentro de la app). Es gratis y siempre lo va a ser — el apoyo ayuda a mantenerlo.

---

## 🧰 Para desarrolladores

```bash
npm run dev          # modo desarrollo (DevTools con Cmd+Opt+I, o OPEN_DEVTOOLS=1 npm run dev)
npm test             # 48 tests (node --test)
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
    ├── photoProcessor.js   # EXIF + geocoding Nominatim
    ├── whatsappBot.js      # máquina de estados de la conversación con Boti
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
