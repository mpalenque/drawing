document.addEventListener('DOMContentLoaded', () => {

  // ========================
  // 1. STATE
  // ========================
  let currentColor = '#d62828'; // Default: red
  let currentSVG = 'woody_clean.svg'; // Default character
  let isDragging = false;

  const urlParams = new URLSearchParams(window.location.search);
  const tabletId = Number.parseInt(urlParams.get('tabletId'), 10) || 1;
  const room = urlParams.get('room') || 'default';
  const channelKey = `toystory-sync-${room}`;
  const sourceId = `tablet-${tabletId}-${Math.random().toString(36).slice(2, 8)}`;

  const socket = typeof io !== 'undefined' ? io() : null;
  const syncChannel = !socket && typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel(channelKey)
    : null;

  function publishEvent(type, payload) {
    if (socket && socket.connected) {
      socket.emit(type, payload);
      return;
    }

    const message = {
      type,
      payload,
      sourceId,
      timestamp: Date.now()
    };

    if (syncChannel) {
      syncChannel.postMessage(message);
    }

    // `storage` event allows fallback sync between tabs/windows in the same browser profile.
    try {
      localStorage.setItem(channelKey, JSON.stringify(message));
    } catch (err) {
      console.warn('No se pudo publicar evento de sincronización local:', err);
    }
  }

  // Cuando el socket se conecta, avisar al videowall qué personaje tiene esta tablet
  if (socket) {
    socket.on('connect', () => {
      console.log(`[Tablet ${tabletId}] Socket conectado. Anunciando SVG: ${currentSVG}`);
      publishEvent('cambiar_personaje', {
        tabletId,
        svgFile: currentSVG
      });
    });
  }

  window.addEventListener('pointerup', () => { isDragging = false; });
  window.addEventListener('pointercancel', () => { isDragging = false; });

  // ========================
  // 2. DOM ELEMENTS
  // ========================
  const svgWrapper = document.getElementById('svg-wrapper');
  const paletteButtons = document.querySelectorAll('.color-btn');
  const charButtons = document.querySelectorAll('.char-btn');

  // ========================
  // 3. LOAD SVG
  // ========================
  function loadSVG(filename) {
    currentSVG = filename;

    svgWrapper.innerHTML = '<div class="loading-msg">Cargando...</div>';

    fetch(filename)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP error ${res.status}`);
        return res.text();
      })
      .then(svgText => {
        // Inject SVG inline so CSS and events can access its elements
        svgWrapper.innerHTML = svgText;

        const svg = svgWrapper.querySelector('svg');
        if (!svg) return;

        // Remove any inline width/height from the SVG root so CSS controls it
        svg.removeAttribute('width');
        svg.removeAttribute('height');
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

        // Apply coloring motor to all paths
        setupColoringPaths(svg);

        // Solo emitir si el socket ya está conectado; si no, el evento 'connect'
        // lo hará automáticamente cuando el socket se establezca
        publishEvent('cambiar_personaje', { tabletId, svgFile: currentSVG });
      })
      .catch(err => {
        console.error('Error loading SVG:', err);
        svgWrapper.innerHTML = '<div class="loading-msg">Error al cargar el personaje.</div>';
      });
  }

  // ========================
  // 4. COLORING MOTOR (DRAG TO PAINT)
  // ========================
  
  svgWrapper.addEventListener('pointerdown', (e) => {
    isDragging = true;
    handlePointerEvent(e);
  });

  svgWrapper.addEventListener('pointermove', (e) => {
    if (isDragging) {
      handlePointerEvent(e);
    }
  });

  function handlePointerEvent(e) {
    // Bloquear scroll
    e.preventDefault(); 
    e.stopPropagation();

    // Obtener elemento exacto bajo el puntero (crucial para arrastrar)
    const target = document.elementFromPoint(e.clientX, e.clientY);
    if (target && target.classList.contains('colorable')) {
      paintPath(target);
    }
  }

  function paintPath(el) {
    if (el.style.fill === currentColor) return; // Evitar repintar con el mismo color

    // Pintar
    el.style.fill = currentColor;

    // Trigger animación crayon
    el.classList.remove('crayon-anim');
    void el.offsetWidth; // Reflow
    el.classList.add('crayon-anim');

    const pathId = el.id;
    console.log(`Pintado: ${pathId} → ${currentColor}`);

    // Sincronización en tiempo real
    publishEvent('pintar_capa', {
      tabletId,
      svgFile: currentSVG,
      elementId: pathId,
      color: currentColor
    });
  }

  function setupColoringPaths(svg) {
    const colorableElements = svg.querySelectorAll('path, polygon, circle, ellipse, rect');

    colorableElements.forEach((el, index) => {
      if (!el.id) {
        el.id = `capa-${index + 1}`;
      }
      el.classList.add('colorable');
    });
  }

  // ========================
  // 5. PALETTE SELECTION
  // ========================
  paletteButtons.forEach(btn => {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();

      // Update active button styling
      paletteButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Update current color
      currentColor = btn.getAttribute('data-color');
    });
  });

  // ========================
  // 6. CHARACTER SELECTION
  // ========================
  charButtons.forEach(btn => {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();

      const svgFile = btn.getAttribute('data-svg');
      if (!svgFile || svgFile === currentSVG) return;

      // Update active character button
      charButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Load new SVG
      loadSVG(svgFile);
    });
  });

  // ========================
  // 7. INIT: Load default SVG
  // ========================
  loadSVG(currentSVG);

  // ========================
  // 8. DRAG AND DROP
  // ========================
  const dragOverlay = document.getElementById('drag-overlay');

  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragOverlay.classList.add('active');
  });

  window.addEventListener('dragover', (e) => {
    e.preventDefault(); // Necesario para permitir el drop
  });

  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    // Prevenir parpadeo cuando el cursor pasa por elementos internos
    if (e.relatedTarget === null) {
      dragOverlay.classList.remove('active');
    }
  });

  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragOverlay.classList.remove('active');

    const file = e.dataTransfer.files[0];
    if (file && (file.type === 'image/svg+xml' || file.name.endsWith('.svg'))) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const svgText = event.target.result;
        
        // Deseleccionar botones de personajes porque ahora usamos uno custom
        charButtons.forEach(b => b.classList.remove('active'));
        currentSVG = 'custom_dropped_file';

        // Inyectar y preparar el SVG
        svgWrapper.innerHTML = svgText;
        const svg = svgWrapper.querySelector('svg');
        if (svg) {
          svg.removeAttribute('width');
          svg.removeAttribute('height');
          svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
          setupColoringPaths(svg);

          publishEvent('cambiar_personaje', {
            tabletId,
            svgFile: currentSVG,
            customSvgContent: svgText
          });
        } else {
          svgWrapper.innerHTML = '<div class="loading-msg">El archivo no contiene un SVG válido.</div>';
        }
      };
      reader.readAsText(file);
    }
  });
});
