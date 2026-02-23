# Descarga catastro

Esta web permite seleccionar varios rectángulos en el mapa (bounding box) y descargar la información sobre _edificios_, _partes de edificios_ y _otras edificaciones_, que se encuentren en el servicio web WFS de https://www.catastro.hacienda.gob.es/webinspire/index.html

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
