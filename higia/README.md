# HIGIA — Protocolo de curaduría de la base de datos de productos

HIGIA es el subsistema del backend dedicado exclusivamente a la **calidad de datos del catálogo** (`productos`). Su objetivo es tener el catálogo lo más preciso posible: nombres, laboratorios, costos/precios, presentaciones y fotos correctos, llevando registro auditable de cada operación (ledger).

## Estructura

```
higia/
├── README.md        # Este protocolo
├── lib/             # Funciones puras reutilizables (sin BD)
│   ├── csv.js       # Escritura CSV (escapado + citado correcto)
│   └── (normalizar, cruzar…) → futuras
├── ops/             # Operaciones CLI, UNA por archivo, dry-run por defecto
│   └── limpiar-fotos.mjs
└── data/            # Registro de corridas (NO se commitear por defecto)
    ├── limpiezas/   # Backups pre-borrado
    └── cruces/      # Ledger de cruces proveedor↔producto
```

## Convenciones

- **dry-run por defecto**: toda operación destructiva imprime qué haría sin tocar la BD.
- **`--apply`** es el único modo que escribe en la BD.
- **Backup antes de modificar**: toda operación que altere datos vuelca el estado previo a CSV antes de escribir.
- **Ledger**: cada corrida deja su CSV de resultados en `higia/data/`.
- **No duplicar lógica**: lo que ya vive en `scripts/lib/` (cobecaParser, drovencentroParser, farmanselmoParser, reconstruccionHelpers) se importa, no se reimplementa.

## Cómo correr

```bash
# lectura / planificación (no escribe)
node ops/limpiar-fotos.mjs

# ejecución real
node ops/limpiar-fotos.mjs --apply
```

## Operaciones

### limpiar-fotos.mjs
Borra todos los `foto_url` de `productos` (quedan NULL → el frontend muestra el icono placeholder). Antes de borrar escribe el backup `data/limpiezas/<fecha>_fotos_antes.csv`.

### Hoja de ruta (próximas)
- Reporte general del catálogo (sin foto, sin mol, sin costo, duplicados por nombre+presentación).
- Cruces proveedor↔producto con ledger en `data/cruces/` (reutilizando los parsers existentes).
- Normalización de nombres/formas (re-export desde `scripts/lib/`).