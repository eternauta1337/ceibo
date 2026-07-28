// Coordinación PURA de operaciones de filesystem (move/rename) in-flight.
//
// El problema que resuelve (QA casos 4 y 6): una op de FS async (move/rename) captura la
// identidad del archivo al DISPARARSE, pero mientras está en vuelo el usuario puede clickear
// otra nota, cambiar de pestaña o disparar otra op. Dos carreras concretas rompían el estado:
//
//   - El autosave del editor (incluido el flush-on-unmount) escribía al MISMO archivo que el
//     move estaba leyendo → el blob sha del origen cambiaba entre el read del cliente y el read
//     del server → 409 "conflict" y el move se revertía (caso 4).
//   - Dos ops de FS se solapaban y la segunda pisaba el estado optimista de la primera.
//
// La solución es un REGISTRO de paths "bajo una op de FS en vuelo": mientras un (repo,path)
// está registrado, el editor NO debe persistir ese archivo por su cuenta (la op es la dueña de
// su ciclo de vida). El registro vive en un ref del glue; acá están las funciones puras que lo
// manipulan, keyed por `repo\0path` (mismo separador estable que explorerReconcile.pendKey).
//
// Para un MOVE/RENAME registramos TANTO el origen como el destino (durante la ventana el archivo
// "existe" en los dos paths a la vez desde el punto de vista del cliente optimista). Para una op
// de CARPETA registramos el prefijo: cualquier path bajo `fromPath/` o `toPath/` cuenta.

/** Identidad estable de un archivo para el registro. El `\0` no aparece en repos ni en paths. */
export const opKey = (repo: string, path: string): string => `${repo}\0${path}`;

/** Una op de FS en vuelo, con la identidad capturada al dispararse. `id` permite des-registrar
 *  exactamente esta op aunque haya varias sobre paths solapados (no borramos de más). */
export interface FsOp {
  id: string;
  repo: string;
  /** Path(s) origen. Para archivo, uno; para carpeta, el prefijo (sin la barra final). */
  fromPath: string;
  /** Path(s) destino. Para archivo, uno; para carpeta, el prefijo (sin la barra final). */
  toPath: string;
  isFolder: boolean;
}

/** ¿El path `(repo,path)` cae bajo la op `op` (origen o destino)?
 *  - archivo: match exacto contra fromPath o toPath.
 *  - carpeta: match del prefijo (`fromPath`/`fromPath/...` o `toPath`/`toPath/...`). */
export function opCoversPath(op: FsOp, repo: string, path: string): boolean {
  if (op.repo !== repo) return false;
  const under = (base: string) => path === base || path.startsWith(`${base}/`);
  if (!op.isFolder) return path === op.fromPath || path === op.toPath;
  return under(op.fromPath) || under(op.toPath);
}

/** ¿Hay ALGUNA op en vuelo que cubra `(repo,path)`? Lo consulta el editor antes de persistir:
 *  si el archivo abierto está bajo una op de FS, el flush/autosave se omite (la op es la dueña).
 *  `ops` es el conjunto vivo de ops registradas (un Map id→FsOp en el glue). */
export function pathHasInflightOp(ops: Iterable<FsOp>, repo: string, path: string): boolean {
  for (const op of ops) {
    if (opCoversPath(op, repo, path)) return true;
  }
  return false;
}

// ── Cola serial por-repo para MUTACIONES de FS ────────────────────────────────────────────────
//
// El registro de ops-en-vuelo (arriba) resuelve la carrera editor↔move. Pero queda otra clase de
// carrera, ENTRE ops de FS: el commit de GitHub se hace con un PATCH del ref `force:false` (no
// fast-forward) sobre un HEAD resuelto un instante antes; dos commits que se solapan en esa ventana
// → el segundo falla con 422 (non-fast-forward) → 409 "conflict" espurio. La defensa de raíz es
// SERIALIZAR las mutaciones por repo: dos ops al mismo repo nunca corren a la vez, así que cada una
// ve el HEAD que dejó la anterior. NO es un lock global — es per-repo y SOLO para mutaciones de FS
// (move/rename/create/delete/archive); lecturas y ops de otros repos no se bloquean.
//
// Implementación: un `Map<repo, Promise>` encadenado. `run(repo, fn)` engancha `fn` al final de la
// cadena del repo y devuelve su resultado. La cadena nunca se rompe por un rechazo (cada eslabón
// captura el error del anterior para no envenenar a los siguientes), pero `run` SÍ propaga el
// resultado/excepción de SU `fn` al caller (cada op maneja su propio error como antes).

export interface FsOpQueue {
  /** Encola `fn` para que corra después de toda mutación previa del mismo `repo`. Devuelve lo que
   *  devuelva `fn` (y propaga su excepción al caller, sin romper la cadena para los siguientes). */
  run<T>(repo: string, fn: () => Promise<T>): Promise<T>;
}

/** Crea una cola serial por-repo. Pura en el sentido de que no toca red ni React: sólo orquesta
 *  promesas. Testeable en node con fns async fake. */
export function createFsOpQueue(): FsOpQueue {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run<T>(repo: string, fn: () => Promise<T>): Promise<T> {
      const prev = tails.get(repo) ?? Promise.resolve();
      // El eslabón nuevo espera al anterior pero IGNORA su resultado/rechazo (`.catch` neutraliza)
      // para que un fallo no bloquee ni envenene la cola; luego corre `fn`.
      const result = prev.then(
        () => fn(),
        () => fn(),
      );
      // La cola (tail) avanza al nuevo eslabón, neutralizado: el próximo `run` espera a que ESTE
      // termine (ok o error) sin heredar su rechazo. Sólo limpiamos el tail si nadie encoló después.
      const link: Promise<unknown> = result.then(
        () => undefined,
        () => undefined,
      );
      tails.set(repo, link);
      void link.then(() => {
        if (tails.get(repo) === link) tails.delete(repo);
      });
      return result;
    },
  };
}
