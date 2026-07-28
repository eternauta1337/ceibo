// Picker de emoji por-nota (estilo Notion), compartido. El "set/clear" del emoji se elige
// desde un botón sutil a la IZQUIERDA del título de la página (ver Editor.tsx) — ya NO desde el
// explorer (que sólo MUESTRA el emoji). Lógica de UI pura; el commit al sidecar `.ceibo/emojis.json`
// pasa por `apiSetEmoji` (POST /api/file/emoji).
//
// El picker abre con una búsqueda (matchea nombre + keywords) sobre el set Unicode completo, y
// una vista por categorías cuando no hay query. El dataset se carga LAZY (ver `emojiData.ts`).
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type EmojiData, type EmojiEntry, loadEmojiData, searchEmojis } from "./emojiData";

// Paleta curada de emojis frecuentes, para ubicar notas visualmente sin tener que buscar
// (estilo Notion). Se muestra como "Frecuentes" arriba de todo cuando no hay búsqueda.
export const EMOJI_PALETTE = [
  "📌",
  "⭐",
  "🔥",
  "✅",
  "📝",
  "💡",
  "📅",
  "🎯",
  "🚀",
  "🐛",
  "📚",
  "💰",
  "❤️",
  "⚠️",
  "🔒",
  "🧠",
  "🎨",
  "🛠️",
  "📊",
  "🌱",
  "🍿",
  "✈️",
  "🏠",
  "👀",
];

// Asignar (o limpiar, con emoji="") el emoji de una nota. Devuelve el mapa path→emoji
// actualizado de la wiki (el server lee/escribe el sidecar `.ceibo/emojis.json`).
export async function apiSetEmoji(
  repo: string,
  path: string,
  emoji: string,
): Promise<Record<string, string>> {
  const r = await fetch("/api/file/emoji", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo, path, emoji }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `emoji ${r.status}`);
  }
  const j = (await r.json()) as { emojis?: Record<string, string> };
  return j.emojis ?? {};
}

/** Popup para elegir el emoji de una nota: search sobre el set Unicode completo + vista por
 *  categorías (con "Frecuentes" arriba) + input nativo para pegar cualquier emoji + "Quitar".
 *  Se portalea a <body> y se ancla a una posición fija; cierra con click afuera o Escape.
 *  Elegir/Quitar dispara `onPick` (Quitar = string vacío). */
export function EmojiPicker({
  x,
  y,
  current,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  current: string;
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(current);
  const [query, setQuery] = useState("");
  const [data, setData] = useState<EmojiData | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let alive = true;
    loadEmojiData().then((d) => {
      if (alive) setData(d);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    // Foco en el search al abrir, para tipear directo.
    searchRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as globalThis.Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // El timeout evita que el mismo click que abrió el picker lo cierre de inmediato.
    const t = setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const results = useMemo(() => (data ? searchEmojis(data, query) : null), [data, query]);

  const renderCell = (char: string) => (
    <button
      key={char}
      type="button"
      className={`exp-emoji-cell${char === current ? " exp-emoji-cell-active" : ""}`}
      onClick={() => onPick(char)}
      aria-label={`Usar ${char}`}
    >
      {char}
    </button>
  );

  return createPortal(
    <div
      ref={ref}
      className="exp-emoji-picker"
      role="dialog"
      aria-label="Elegir emoji de la nota"
      style={{ position: "fixed", top: y, left: x }}
    >
      <input
        ref={searchRef}
        className="exp-emoji-search"
        value={query}
        placeholder="Buscar emoji…"
        onChange={(ev) => setQuery(ev.target.value)}
        onKeyDown={(ev) => {
          const first = results?.[0];
          if (ev.key === "Enter" && first) {
            ev.preventDefault();
            onPick(first.char);
          }
        }}
        aria-label="Buscar emoji"
      />

      <div className="exp-emoji-scroll">
        {results ? (
          results.length > 0 ? (
            <div className="exp-emoji-grid">{results.map((e: EmojiEntry) => renderCell(e.char))}</div>
          ) : (
            <div className="exp-emoji-empty">Sin resultados</div>
          )
        ) : (
          <>
            <div className="exp-emoji-group-label">Frecuentes</div>
            <div className="exp-emoji-grid">{EMOJI_PALETTE.map((e) => renderCell(e))}</div>
            {data ? (
              data.groups.map((g) => (
                <div key={g.slug}>
                  <div className="exp-emoji-group-label">{g.name}</div>
                  <div className="exp-emoji-grid">{g.emojis.map((e) => renderCell(e.char))}</div>
                </div>
              ))
            ) : (
              <div className="exp-emoji-empty">Cargando…</div>
            )}
          </>
        )}
      </div>

      <div className="exp-emoji-custom">
        <input
          className="exp-emoji-input"
          value={text}
          maxLength={32}
          placeholder="o pegá un emoji"
          onChange={(ev) => setText(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") {
              ev.preventDefault();
              onPick(text);
            }
          }}
          aria-label="Emoji personalizado"
        />
        <button type="button" className="exp-emoji-set" onClick={() => onPick(text)}>
          OK
        </button>
      </div>
      {current && (
        <button type="button" className="exp-emoji-clear" onClick={() => onPick("")}>
          Quitar emoji
        </button>
      )}
    </div>,
    document.body,
  );
}
