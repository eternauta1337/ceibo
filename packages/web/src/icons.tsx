// Icon kit consistente para TODO el chrome (botones, composer, etc.). Estilo Lucide
// (lucide.dev, ISC): viewBox 24, sin fill, `stroke: currentColor`, mismo grosor y caps
// redondos. Un solo lugar → look uniforme (antes era una mezcla de emojis/glifos ✕ ⚙ ☰ + ➤
// y SVGs ad-hoc con grosores distintos). `currentColor` hereda el color del botón.
import type { ReactNode } from "react";

function Icon({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

type IconProps = { size?: number };

/** Play (reanudar la nota de voz en el player espejo del chat). */
export function IconPlay(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="m6 4 14 8-14 8V4z" />
    </Icon>
  );
}

/** Pausa (la nota de voz está sonando en el player espejo del chat). */
export function IconPause(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M10 5v14" />
      <path d="M14 5v14" />
    </Icon>
  );
}

/** Cerrar / quitar (✕). */
export function IconX(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Icon>
  );
}

/** Configuración (engranaje). */
export function IconSettings(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  );
}

/** Reloj — agenda / recordatorios (crons). */
export function IconClock(p: IconProps) {
  return (
    <Icon {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Icon>
  );
}

/** Enchufe — conexiones / canales (cuentas externas + por dónde habla con ceibo). */
export function IconPlug(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
    </Icon>
  );
}

/** Abrir el panel lateral (explorador). */
export function IconPanelLeft(p: IconProps) {
  return (
    <Icon {...p}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </Icon>
  );
}

/** Cerrar / colapsar el panel lateral: igual que IconPanelLeft pero con la sección lateral
 *  más fina (el divisor más cerca del borde) → sugiere "achicar/ocultar" el panel. */
export function IconPanelLeftClose(p: IconProps) {
  return (
    <Icon {...p}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M7 3v18" />
    </Icon>
  );
}

/** Nueva nota (+). */
export function IconPlus(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </Icon>
  );
}

/** Enviar (flecha hacia arriba, estilo composer de chat). */
export function IconArrowUp(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </Icon>
  );
}

/** Micrófono. */
export function IconMic(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <path d="M12 19v3" />
    </Icon>
  );
}

/** Check (✓) — terminar y enviar el audio. */
export function IconCheck(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M20 6 9 17l-5-5" />
    </Icon>
  );
}

/** Burbuja de chat (launcher). */
export function IconMessage(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
    </Icon>
  );
}

/** Campanita — notificaciones / inbox del agente (feature crons-delivery). */
export function IconBell(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </Icon>
  );
}

/** Navegar atrás (flecha izquierda) — historial de la pestaña, estilo Obsidian. */
export function IconArrowLeft(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </Icon>
  );
}

/** Navegar adelante (flecha derecha) — historial de la pestaña, estilo Obsidian. */
export function IconArrowRight(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </Icon>
  );
}

/** Maximizar (flechas hacia las esquinas) — agrandar el chat al área de contenido. */
export function IconMaximize(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
      <path d="M3 16v3a2 2 0 0 0 2 2h3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </Icon>
  );
}

/** Personas (autoría compartida) — toggle de blame por línea en wikis compartidas. */
export function IconUsers(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Icon>
  );
}

/** Restaurar / minimizar (flechas hacia el centro) — volver el chat al rincón. */
export function IconMinimize(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M8 3v3a2 2 0 0 1-2 2H3" />
      <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
      <path d="M3 16h3a2 2 0 0 1 2 2v3" />
      <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
    </Icon>
  );
}

/** Inicio / home — volver a la pantalla principal (orb) manteniendo las tabs vivas. */
export function IconHome(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </Icon>
  );
}

/** Orb — minimizar notas y volver a la vista del orbe (anillos concéntricos). */
export function IconOrb(p: IconProps) {
  return (
    <Icon {...p}>
      <circle cx="12" cy="12" r="3" />
      <circle cx="12" cy="12" r="6.5" />
      <circle cx="12" cy="12" r="10" />
    </Icon>
  );
}

/** Cuaderno abierto — restaurar las notas minimizadas. */
export function IconBookOpen(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M2 3h9a1 1 0 0 1 1 1v16a1 1 0 0 0-1-1H2z" />
      <path d="M22 3h-9a1 1 0 0 0-1 1v16a1 1 0 0 1 1-1h9z" />
    </Icon>
  );
}

/** Launcher / páginas de sistema: grilla 2×2 de cuadrados (estilo apps/grid). */
export function IconLauncher(p: IconProps) {
  return (
    <Icon {...p}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </Icon>
  );
}

/** Compartir — círculo central con 3 nodos conectados (share graph). */
export function IconShare(p: IconProps) {
  return (
    <Icon {...p}>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="M8.59 13.51 15.42 17.49" />
      <path d="M15.41 6.51 8.59 10.49" />
    </Icon>
  );
}

/** Archivar — caja con tapa (archive box). */
export function IconArchive(p: IconProps) {
  return (
    <Icon {...p}>
      <rect width="20" height="5" x="2" y="3" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </Icon>
  );
}

/** Eliminar — tacho de basura. */
export function IconTrash(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </Icon>
  );
}

/** Salir de wiki — puerta con flecha hacia afuera. */
export function IconLogOut(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </Icon>
  );
}

/** Vista de archivo (otra cara del explorer) — caja con flecha subiendo (restaurar). */
export function IconArchiveView(p: IconProps) {
  return (
    <Icon {...p}>
      <rect width="20" height="5" x="2" y="3" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M12 12v6" />
      <path d="m9 15 3-3 3 3" />
    </Icon>
  );
}

/** Explorador — volver a la vista del explorador desde el archivo (grilla como IconLauncher pero simplificada). */
export function IconExplorerView(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M3 9h18" />
      <path d="M3 15h18" />
      <path d="M9 3v18" />
    </Icon>
  );
}

/** Explorador de archivos — carpeta (abrir/explorar las notas). Distinto del glifo de
 *  "panel lateral" (IconPanelLeft), que ahora es el botón de la activity bar. */
export function IconFiles(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2Z" />
    </Icon>
  );
}

/** Perfil — silueta de un usuario (persona). */
export function IconUser(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </Icon>
  );
}

/** Apariencia — paleta de colores. */
export function IconPalette(p: IconProps) {
  return (
    <Icon {...p}>
      <circle cx="13.5" cy="6.5" r="0.5" />
      <circle cx="17.5" cy="10.5" r="0.5" />
      <circle cx="8.5" cy="7.5" r="0.5" />
      <circle cx="6.5" cy="12.5" r="0.5" />
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
    </Icon>
  );
}

/** Idioma y voz — globo con meridianos (estilo Lucide "globe"): idioma del asistente + voz. */
export function IconLanguages(p: IconProps) {
  return (
    <Icon {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </Icon>
  );
}

/** Agregar miembro — silueta de usuario con un +. */
export function IconUserPlus(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <line x1="19" y1="8" x2="19" y2="14" />
      <line x1="22" y1="11" x2="16" y2="11" />
    </Icon>
  );
}
