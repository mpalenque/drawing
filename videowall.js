document.addEventListener('DOMContentLoaded', () => {
  const socket = typeof io !== 'undefined' ? io() : null;

  const urlParams = new URLSearchParams(window.location.search);
  const room = urlParams.get('room') || 'default';
  const channelKey = `toystory-sync-${room}`;
  const sourceId = `videowall-${Math.random().toString(36).slice(2, 8)}`;

  const syncChannel = !socket && typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel(channelKey)
    : null;

  // Estado local del videowall para saber qué SVG tiene cada tablet cargado
  const tabletStates = {
    1: { currentSVG: null },
    2: { currentSVG: null },
    3: { currentSVG: null },
    4: { currentSVG: null },
    5: { currentSVG: null },
    6: { currentSVG: null }
  };

  // Función para cargar un SVG en una ranura específica
  function loadSVGToSlot(tabletId, svgFile, customSvgContent = null) {
    const slotCanvas = document.getElementById(`canvas-${tabletId}`);
    const slotContainer = document.getElementById(`slot-${tabletId}`);
    if (!slotCanvas || !slotContainer) return;

    slotContainer.classList.add('active');

    // Si es un archivo custom droppeado
    if (svgFile === 'custom_dropped_file' && customSvgContent) {
      injectSVG(slotCanvas, customSvgContent, tabletId, svgFile);
      return;
    }

    // Si es uno de los predeterminados, hacer fetch
    fetch(svgFile)
      .then(res => res.text())
      .then(svgText => {
        injectSVG(slotCanvas, svgText, tabletId, svgFile);
      })
      .catch(err => {
        console.error(`Error cargando ${svgFile} en tablet ${tabletId}`, err);
      });
  }

  function injectSVG(slotCanvas, svgText, tabletId, svgFile) {
    slotCanvas.innerHTML = svgText;
    const svg = slotCanvas.querySelector('svg');
    if (svg) {
      svg.removeAttribute('width');
      svg.removeAttribute('height');
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      
      // Mark slot as active (white background)
      const slotContainer = document.getElementById(`slot-${tabletId}`);
      if (slotContainer) slotContainer.classList.add('has-svg');

      // Assign IDs to paths so they match the tablet exactly
      const colorableElements = svg.querySelectorAll('path, polygon, circle, ellipse, rect');
      colorableElements.forEach((el, index) => {
        if (!el.id) {
          el.id = `capa-${index + 1}`;
        }
      });
      
      tabletStates[tabletId].currentSVG = svgFile;
    }
  }

  function handleSyncEvent(data) {
    if (!data || !data.type || !data.payload) return;

    if (data.type === 'cambiar_personaje') {
      const { tabletId, svgFile, customSvgContent } = data.payload;
      if (tabletId >= 1 && tabletId <= 6) {
        loadSVGToSlot(tabletId, svgFile, customSvgContent);
      }
      return;
    }

    if (data.type === 'pintar_capa') {
      const { tabletId, svgFile, elementId, color } = data.payload;
      if (tabletId < 1 || tabletId > 6) return;

      // Si la tablet tiene un SVG diferente cargado al que nosotros tenemos, sincronizamos primero.
      if (tabletStates[tabletId].currentSVG !== svgFile) {
        console.warn(`Desincronización en tablet ${tabletId}. Tiene ${svgFile} pero el videowall tiene ${tabletStates[tabletId].currentSVG}`);
      }

      const slotCanvas = document.getElementById(`canvas-${tabletId}`);
      if (slotCanvas) {
        const pathToColor = slotCanvas.querySelector(`#${elementId}`);
        if (pathToColor) {
          pathToColor.style.fill = color;
        }
      }
    }
  }

  // Escuchar cuando una tablet cambia de personaje
  if (socket) {
    socket.on('cambiar_personaje', (payload) => {
      handleSyncEvent({ type: 'cambiar_personaje', payload });
    });

    socket.on('pintar_capa', (payload) => {
      handleSyncEvent({ type: 'pintar_capa', payload });
    });
  } else {
    console.info('Socket.io no disponible. Usando sincronización local para GitHub Pages.');

    if (syncChannel) {
      syncChannel.onmessage = (event) => {
        const message = event.data;
        if (!message || message.sourceId === sourceId) return;
        handleSyncEvent(message);
      };
    }

    window.addEventListener('storage', (event) => {
      if (event.key !== channelKey || !event.newValue) return;

      try {
        const message = JSON.parse(event.newValue);
        if (!message || message.sourceId === sourceId) return;
        handleSyncEvent(message);
      } catch (err) {
        console.warn('No se pudo parsear evento local de sincronización:', err);
      }
    });
  }
});
