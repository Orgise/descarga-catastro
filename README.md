# Descarga Catastro

Aplicación web para seleccionar zonas en el mapa y descargar datos de construcciones del servicio WFS INSPIRE de Catastro:

- `bu:Building`
- `bu:BuildingPart`
- `bu:OtherConstruction` (piscinas al aire libre)

La salida se genera en `GeoJSON` listo para revisión o carga en JOSM.

## Funcionalidades

- Dibujo de múltiples rectángulos sobre el mapa.
- Selección de rectángulo activo.
- Mover, rotar y escalar el rectángulo activo.
- Clonar rectángulos con clic derecho (el clon pasa a ser el activo).
- Eliminar rectángulos con clic central o tecla `Supr`.
- Cálculo de área en tiempo real y validación de límite máximo.
- Exportación a fichero (`Descargar`) o envío directo a `JOSM`.
- Procesamiento masivo de rectángulos ámbar con progreso `(n/X completados)`.
- Envío masivo a JOSM de todos los rectángulos verdes.
- Reutilización de exportaciones correctas: rectángulos verdes se descargan/abren sin relanzar exportación.
- Estado visual por rectángulo (pendiente, éxito, error).
- Búsqueda de ubicaciones, selector de capas y persistencia de vista del mapa en la sesión.

## Guía de uso (paso a paso)

1. Abre la aplicación en el navegador.
2. Localiza la zona:
   - Usa la búsqueda (arriba a la izquierda), o
   - Navega manualmente con zoom y arrastre.
3. Opcional: activa/desactiva capas en el selector:
   - Base: OpenStreetMap.
   - Superposiciones: PNOA y Catastro.
4. Dibuja un rectángulo con la herramienta de dibujo.
5. Ajusta el rectángulo activo:
   - Arrastra para mover.
   - Usa los manejadores para escalar/rotar.
   - Usa el interruptor `Escalado uniforme` para mantener proporciones al escalar.
6. Si necesitas zonas similares:
   - Haz clic derecho sobre un rectángulo para clonarlo.
   - El clon queda seleccionado automáticamente.
7. Revisa el panel lateral:
   - Coordenadas `xmin ymin xmax ymax` (WGS84).
   - Botón de copia de coordenadas.
   - Área estimada y aviso de límite.
8. Exporta:
   - `Descargar`: baja el `GeoJSON` en el navegador.
   - `JOSM`: abre Remote Control en `127.0.0.1:8111` para importar la capa en JOSM.
9. Para exportar en bloque:
   - Pulsa `Procesar rectángulos ámbar (X)`.
   - Se mostrará el modal `Procesando, espera... (n/X completados)`.
   - Durante ese proceso, la interfaz queda bloqueada hasta terminar.
10. Una vez un rectángulo esté en verde:
   - `Descargar` o `JOSM` reutiliza su exportación ya preparada.
   - No se vuelve a lanzar `/export` para ese rectángulo mientras no cambie su geometría.
11. Para enviar todos los verdes a JOSM:
   - Pulsa `JOSM rectángulos verdes (X)`.
   - Se enviará una importación por cada rectángulo verde (una capa por elemento).

## Controles

- Clic izquierdo en rectángulo: selecciona rectángulo activo.
- Arrastre y manejadores: mover, escalar, rotar el rectángulo activo.
- Clic derecho en rectángulo: clona el rectángulo y activa el clon.
- Clic central en rectángulo: elimina ese rectángulo.
- Tecla `Supr`: elimina el rectángulo activo.
- Botón `Procesar rectángulos ámbar`: exporta en secuencia todos los pendientes.
- Botón `JOSM rectángulos verdes`: envía en lote todos los exportados con éxito.

## Reglas y validaciones

- Área máxima permitida: `0.5 km²`.
- Si se supera el límite:
  - Se muestra aviso `Máx 0.5 km²`.
  - Se deshabilitan `Descargar` y `JOSM`.
- Se descartan rectángulos demasiado pequeños (umbral interno: `100 m²`).
- Cada rectángulo guarda su propio estado de exportación.
- Si modificas geometría (mover/escalar/rotar), el estado previo de exportación se reinicia.
- El proceso masivo exporta solo rectángulos en estado pendiente (ámbar/azul).
- Cada rectángulo actualiza su color al finalizar su exportación individual:
  - Verde si tuvo éxito.
  - Rojo si falló.

## Significado de colores

- Azul: rectángulo activo pendiente de exportar.
- Ámbar: rectángulo inactivo pendiente de exportar.
- Verde: última exportación correcta.
- Rojo: última exportación con error.

## Exportación a JOSM

Para que funcione el botón `JOSM`:

1. Abre JOSM.
2. Activa `Remote Control` en preferencias.
3. Permite peticiones locales a `http://127.0.0.1:8111`.

Si el navegador bloquea ventanas emergentes, permite popups para este sitio.

Para el envío masivo de verdes, el navegador puede solicitar permiso para múltiples aperturas hacia Remote Control.

## Ejecución local

Puerto por defecto: `8000` (configurable con `PORT`).

### Opción recomendada: Docker

#### Docker build/run

1. Construir imagen:
   `docker build -t descarga-catastro .`
2. Ejecutar contenedor:
   `docker run --rm --init -p 8000:8000 descarga-catastro`
3. Abrir:
   `http://localhost:8000`

#### Docker Compose

```sh
# Primera ejecución (con build)
docker-compose up --build

# Siguientes ejecuciones
docker-compose up

# Parar y limpiar
docker-compose down
```

### Opción sin Docker

Requiere herramientas del sistema usadas por `run_export.sh`: `curl`, `jq`, `proj (cs2cs)`, `gdal/ogr2ogr/ogrinfo`, `spatialite`.

1. Instalar dependencias de Node:
   `npm install`
2. Asegurar permisos del script:
   `chmod +x run_export.sh`
3. Arrancar servidor:
   `npm start`
4. Abrir:
   `http://localhost:8000`

## Resolución de problemas

- Error de teselas de Catastro:
  - El servicio puede fallar fuera de España o por disponibilidad temporal.
- `JOSM` no abre nada:
  - Revisa que JOSM esté abierto con Remote Control activo.
- Exportación devuelve error:
  - Prueba una zona menor.
  - Verifica conectividad al WFS de Catastro.
  - Reintenta más tarde si hay caída temporal del servicio.
