const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

// Servir archivos estáticos del directorio actual
app.use(express.static(__dirname));

// Auto-descubrimiento de IP local para mostrar en consola
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Omitir internas e IPv6
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// Lógica de Socket.io
io.on('connection', (socket) => {
  console.log(`Un cliente se ha conectado: ${socket.id}`);

  // Evento cuando una tablet pinta una capa
  socket.on('pintar_capa', (data) => {
    // data = { tabletId, svgFile, elementId, color }
    // Reenviar a todos (especialmente al videowall)
    io.emit('pintar_capa', data);
  });

  // Evento cuando una tablet dibuja un trazo dentro de una capa
  socket.on('dibujar_trazo', (data) => {
    // data = { tabletId, svgFile, elementId, color, brushSizePx, points }
    io.emit('dibujar_trazo', data);
  });

  // Evento cuando una tablet cambia de personaje o carga un SVG nuevo
  socket.on('cambiar_personaje', (data) => {
    // data = { tabletId, svgFile, customSvgContent }
    io.emit('cambiar_personaje', data);
  });

  // Evento cuando termina el tiempo de una tablet y vuelve al selector
  socket.on('terminar_dibujo', (data) => {
    // data = { tabletId }
    io.emit('terminar_dibujo', data);
  });

  socket.on('disconnect', () => {
    console.log(`Cliente desconectado: ${socket.id}`);
  });
});

// Iniciar servidor en 0.0.0.0 para que escuche en la red local
server.listen(PORT, '0.0.0.0', () => {
  const localIp = getLocalIP();
  console.log('==================================================');
  console.log('🚀 SERVIDOR LOCAL DE TOY STORY DIBUJOS INICIADO 🚀');
  console.log('==================================================');
  console.log(`✅ Para el Videowall 4K, abre: http://localhost:${PORT}/videowall.html`);
  console.log(`✅ Para configurar las Tablets (APK), usa esta IP base:`);
  console.log(`\n    http://${localIp}:${PORT}\n`);
  console.log(`   Por ejemplo, para la tablet 1 ingresa:`);
  console.log(`    http://${localIp}:${PORT}/?tabletId=1`);
  console.log(`    http://${localIp}:${PORT}/?tabletId=2  (tablet 2, etc...)`);
  console.log('==================================================');
});
