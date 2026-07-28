# Contribuir

Este repo está publicado como **muestra de trabajo archivada**, no como un proyecto que
busca mantenedores. No hay roadmap ni compromiso de respuesta.

Dicho eso: si encontrás un bug, tenés una pregunta sobre alguna decisión de diseño, o
querés proponer algo, un issue es bienvenido.

## Si querés mandar un PR

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test
```

Los tres tienen que pasar — el pre-push de husky los corre igual. CI hace lo mismo sobre
cada PR.

Un par de cosas que ayudan:

- **Mantené la regla de no-ciclos** entre paquetes. Si tu cambio necesita que una hoja
  importe algo de arriba, probablemente el código va en otro lado.
- **Tests co-locados**: `foo.test.ts` al lado de `foo.ts`.
- **No bajes los pisos de cobertura** de `vitest.config.ts` para que pase tu cambio.
- **Español** en comentarios y mensajes, para no dejar el repo a medio traducir.
- Si el cambio se nota desde afuera, dejá un fragmento en `changelog.d/` (ver su
  `README.md`).

Los comentarios largos de este código casi siempre documentan un bug que ya pasó. Si tocás
esa zona, actualizá la explicación en lugar de borrarla.
