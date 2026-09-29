// Word Grove — localized strings for the Graphics settings section.
// The rest of the game is English-only; these strings follow navigator.language.

const EN = {
  graphics: 'Graphics', quality: 'Quality', auto: 'Auto (detected: {tier})',
  renderScale: 'Render scale', fromPreset: 'From preset ({tier})',
  adaptive: 'Adaptive resolution', showFps: 'Show frame rate',
  postFailed: 'Post-processing is unavailable on this device, so the grove renders without it.',
  unknownGpu: 'unknown GPU',
  cat: {
    shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Color grade',
    antialias: 'Anti-aliasing', reflections: 'Reflections', particles: 'Particles',
    background: 'Ambient motion', detail: 'Scene detail',
  },
  tier: {
    low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra', medium: 'Medium',
    off: 'Off', on: 'On', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    static: 'Static', animated: 'Animated', plain: 'Plain', detailed: 'Detailed',
  },
  sum: { noShadows: 'no shadows', shadows: 'shadows', ao: 'ambient occlusion', bloom: 'bloom', reflections: 'reflections', noAA: 'no anti-aliasing' },
};

const ES = {
  graphics: 'Gráficos', quality: 'Calidad', auto: 'Automática (detectada: {tier})',
  renderScale: 'Escala de renderizado', fromPreset: 'Según el ajuste ({tier})',
  adaptive: 'Resolución adaptativa', showFps: 'Mostrar fotogramas por segundo',
  postFailed: 'El posprocesado no está disponible en este dispositivo; la arboleda se muestra sin él.',
  unknownGpu: 'GPU desconocida',
  cat: {
    shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Corrección de color',
    antialias: 'Antialiasing', reflections: 'Reflejos', particles: 'Partículas',
    background: 'Movimiento ambiental', detail: 'Detalle de escena',
  },
  tier: {
    low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra', medium: 'Media',
    off: 'No', on: 'Sí', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    static: 'Estático', animated: 'Animado', plain: 'Sencillo', detailed: 'Detallado',
  },
  sum: { noShadows: 'sin sombras', shadows: 'sombras', ao: 'oclusión ambiental', bloom: 'resplandor', reflections: 'reflejos', noAA: 'sin antialiasing' },
};

const FR = {
  graphics: 'Graphismes', quality: 'Qualité', auto: 'Auto (détectée : {tier})',
  renderScale: 'Échelle de rendu', fromPreset: 'Selon le préréglage ({tier})',
  adaptive: 'Résolution adaptative', showFps: 'Afficher les images par seconde',
  postFailed: 'Le post-traitement n’est pas disponible sur cet appareil ; le bosquet s’affiche sans.',
  unknownGpu: 'GPU inconnu',
  cat: {
    shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Étalonnage des couleurs',
    antialias: 'Anticrénelage', reflections: 'Reflets', particles: 'Particules',
    background: 'Mouvement ambiant', detail: 'Détail de la scène',
  },
  tier: {
    low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra', medium: 'Moyenne',
    off: 'Non', on: 'Oui', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    static: 'Statique', animated: 'Animé', plain: 'Simple', detailed: 'Détaillé',
  },
  sum: { noShadows: 'sans ombres', shadows: 'ombres', ao: 'occlusion ambiante', bloom: 'halo', reflections: 'reflets', noAA: 'sans anticrénelage' },
};

const STRINGS = {
  'en-US': EN,
  'en-GB': { ...EN, cat: { ...EN.cat, grade: 'Colour grade' } },
  'es-419': ES,
  'es-ES': { ...ES, cat: { ...ES.cat, antialias: 'Suavizado de bordes' }, sum: { ...ES.sum, noAA: 'sin suavizado' } },
  'de-DE': {
    graphics: 'Grafik', quality: 'Qualität', auto: 'Automatisch (erkannt: {tier})',
    renderScale: 'Renderskalierung', fromPreset: 'Wie Voreinstellung ({tier})',
    adaptive: 'Adaptive Auflösung', showFps: 'Bildrate anzeigen',
    postFailed: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar, daher wird der Hain ohne sie dargestellt.',
    unknownGpu: 'unbekannte GPU',
    cat: {
      shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Leuchteffekt', grade: 'Farbkorrektur',
      antialias: 'Kantenglättung', reflections: 'Spiegelungen', particles: 'Partikel',
      background: 'Umgebungsbewegung', detail: 'Szenendetails',
    },
    tier: {
      low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra', medium: 'Mittel',
      off: 'Aus', on: 'An', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
      static: 'Statisch', animated: 'Animiert', plain: 'Einfach', detailed: 'Detailliert',
    },
    sum: { noShadows: 'keine Schatten', shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Leuchteffekt', reflections: 'Spiegelungen', noAA: 'keine Kantenglättung' },
  },
  'fr-FR': FR,
  'fr-CA': { ...FR, tier: { ...FR.tier, off: 'Désactivé', on: 'Activé' } },
  'pt-BR': {
    graphics: 'Gráficos', quality: 'Qualidade', auto: 'Automática (detectada: {tier})',
    renderScale: 'Escala de renderização', fromPreset: 'Conforme predefinição ({tier})',
    adaptive: 'Resolução adaptativa', showFps: 'Mostrar taxa de quadros',
    postFailed: 'O pós-processamento não está disponível neste dispositivo; o bosque é exibido sem ele.',
    unknownGpu: 'GPU desconhecida',
    cat: {
      shadows: 'Sombras', ao: 'Oclusão ambiente', bloom: 'Brilho', grade: 'Correção de cor',
      antialias: 'Antisserrilhamento', reflections: 'Reflexos', particles: 'Partículas',
      background: 'Movimento ambiente', detail: 'Detalhe da cena',
    },
    tier: {
      low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra', medium: 'Média',
      off: 'Desligado', on: 'Ligado', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
      static: 'Estático', animated: 'Animado', plain: 'Simples', detailed: 'Detalhado',
    },
    sum: { noShadows: 'sem sombras', shadows: 'sombras', ao: 'oclusão ambiente', bloom: 'brilho', reflections: 'reflexos', noAA: 'sem antisserrilhamento' },
  },
  'it-IT': {
    graphics: 'Grafica', quality: 'Qualità', auto: 'Automatica (rilevata: {tier})',
    renderScale: 'Scala di rendering', fromPreset: 'Da preimpostazione ({tier})',
    adaptive: 'Risoluzione adattiva', showFps: 'Mostra frequenza fotogrammi',
    postFailed: 'La post-elaborazione non è disponibile su questo dispositivo, quindi il boschetto viene mostrato senza.',
    unknownGpu: 'GPU sconosciuta',
    cat: {
      shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore', grade: 'Correzione colore',
      antialias: 'Antialiasing', reflections: 'Riflessi', particles: 'Particelle',
      background: 'Movimento ambientale', detail: 'Dettaglio scena',
    },
    tier: {
      low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra', medium: 'Media',
      off: 'No', on: 'Sì', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
      static: 'Statico', animated: 'Animato', plain: 'Semplice', detailed: 'Dettagliato',
    },
    sum: { noShadows: 'senza ombre', shadows: 'ombre', ao: 'occlusione ambientale', bloom: 'bagliore', reflections: 'riflessi', noAA: 'senza antialiasing' },
  },
};

export const GFX_LOCALES = Object.keys(STRINGS);

/** Best supported locale for a BCP-47 tag (exact, then language fallback). */
export function pickLocale(tag) {
  const t = String(tag || 'en-US');
  const exact = GFX_LOCALES.find((l) => l.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const lang = t.slice(0, 2).toLowerCase();
  if (lang === 'es') return /-(es)$/i.test(t) ? 'es-ES' : 'es-419';
  if (lang === 'fr') return /-ca$/i.test(t) ? 'fr-CA' : 'fr-FR';
  if (lang === 'en') return /-(gb|uk|ie|au|nz)$/i.test(t) ? 'en-GB' : 'en-US';
  return { de: 'de-DE', pt: 'pt-BR', it: 'it-IT' }[lang] || 'en-US';
}

export function gfxStrings(tag) {
  return STRINGS[pickLocale(tag)];
}
