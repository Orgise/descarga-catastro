# Descarga catastro

Esta web permite dibujar y manipular varios rectángulos en el mapa (bounding box) y descargar la información sobre *edificios*, *partes de edificios* y *otras edificaciones*, que se encuentren en el servicio web WFS de https://www.catastro.hacienda.gob.es/webinspire/index.html dentro del área dibujada.

Se usan colores en los rectángulos para ayudar a organizarse cuando se exportan zonas grandes.

Colores:

- Ámbar: sin exportar.
- Verde: exportación satisfactoria.
- Rojo: fallo al exportar.

Controles
-------------------
- Clic izquierdo: selccionar/mover/rotar/escalar el rectángulo activo.
- Clic central o tecla Supr: eliminar el rectángulo.


## Build local con Docker

### Usando docker build

Puerto por defecto: `8000` (configurable con variables de entorno)

1. Construir imagen:
   `docker build -t descarga-catastro .`

2. Ejecutar contenedor:
   `docker run --rm --init -p 8000:8000 descarga-catastro`

3. Abrir en el navegador:
   http://localhost:8000
   

### Usando docker-compose

~~~ sh
# Arrancar por primera vez.
docker-compose up --build
# Arranque normal.
docker-compose up
# Detener y limpiar.
docker-compose down
~~~
