# Denuncia Rápida 🚗

Aplicación de escritorio para automatizar denuncias de mal estacionamiento en Buenos Aires a través del bot de WhatsApp de BA Ciudad.

## 🎯 ¿Qué hace?

1. **Subís una foto** del auto mal estacionado
2. **Extrae automáticamente:**
   - Ubicación GPS → Dirección
   - Fecha y hora de la foto
3. **Se conecta a WhatsApp** y habla con el bot de BA Ciudad
4. **Completa todo el proceso** automáticamente
5. **Recibís el número de trámite** 🎉

## ⚠️ Advertencia

Esta app usa `whatsapp-web.js` que no es oficial y va contra los TOS de WhatsApp. Usala bajo tu propio riesgo. Recomendamos usar un número secundario.

## 🛠️ Requisitos

- Node.js 18 o superior
- npm o yarn
- Una cuenta de WhatsApp

## 🚀 Instalación

```bash
# Clonar o descargar el proyecto
cd denuncia-rapida

# Instalar dependencias
npm install

# Ejecutar en modo desarrollo
npm run dev

# O ejecutar normalmente
npm start
```

## 📱 Primer uso

1. Abrí la app
2. Hacé click en "Conectar WhatsApp"
3. Escaneá el QR con WhatsApp (como WhatsApp Web)
4. ¡Listo! La sesión se guarda para la próxima vez

## 🔄 Flujo de uso

```
┌─────────────────┐
│   Subir foto    │
└────────┬────────┘
         ▼
┌─────────────────┐
│ Verificar datos │  ← GPS, fecha, descripción
└────────┬────────┘
         ▼
┌─────────────────┐
│ Enviar denuncia │  ← Automático vía WhatsApp
└────────┬────────┘
         ▼
┌─────────────────┐
│ Nro de trámite  │  🎉
└─────────────────┘
```

## 📸 Tips para las fotos

- **Asegurate que el GPS esté habilitado** en tu cámara/celular
- La foto debe tener la **patente visible**
- Mejor si también se ve el **contexto** (garage, rampa, etc.)

## 🗂️ Estructura del proyecto

```
denuncia-rapida/
├── src/
│   ├── main/
│   │   ├── main.js        # Proceso principal de Electron
│   │   └── preload.js     # Puente seguro IPC
│   ├── renderer/
│   │   ├── index.html     # UI
│   │   ├── styles.css     # Estilos
│   │   └── app.js         # Lógica del frontend
│   └── lib/
│       ├── photoProcessor.js   # Extracción EXIF + geocoding
│       └── whatsappBot.js      # Automatización WhatsApp
└── package.json
```

## 🔧 Desarrollo

```bash
# Modo desarrollo (con DevTools)
npm run dev

# La sesión de WhatsApp se guarda en:
# ~/.denuncia-rapida-session/
```

## 📝 TODO / Mejoras futuras

- [ ] OCR para detectar patentes automáticamente
- [ ] Soporte para múltiples fotos (contexto + patente)
- [ ] Historial de denuncias
- [ ] Versión mobile (con servidor backend)
- [ ] Notificaciones cuando cambie el estado del trámite

## 🤝 Contribuciones

¡PRs bienvenidos! Especialmente para:
- Mejorar la detección de estados del bot
- Agregar OCR de patentes
- Mejorar la UI/UX

## 📄 Licencia

MIT - Usalo como quieras, pero bajo tu propia responsabilidad.

---

Hecho con ☕ para los vecinos de Buenos Aires que quieren una ciudad mejor ordenada.
