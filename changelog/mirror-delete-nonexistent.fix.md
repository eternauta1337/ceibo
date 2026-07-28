Espejo git: un `delete` de una nota que no está en git HEAD (creada y borrada por el
contrato antes de espejar) ahora es no-op en vez de mandarse al Git Data API — evita el
`BadObjectState` que trababa la cola de espejo de esa wiki. Detectado en el cutover de prod.
