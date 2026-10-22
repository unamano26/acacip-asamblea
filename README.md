# Asamblea ACACIP

App de votación para la Asamblea General de Socios de ACACIP.

- `/` — socios: ingresan con su DNI y votan Positivo, Negativo o Abstención.
- `/mesa` — panel de la mesa (contraseña en la variable de entorno `ADMIN_PASSWORD` de Netlify).

Voto secreto: se registra que un DNI votó (`voto-dni/...`) por separado de la boleta (`boletas/...`), que no lleva datos del socio.
Datos en Netlify Blobs (store `asamblea`).
