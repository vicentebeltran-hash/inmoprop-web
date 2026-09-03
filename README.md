# Inmoprop AI — landing

Web estática de una sola página. Sin build, sin dependencias: `index.html` + `assets/`.

## Estructura

```
index.html          La landing completa (CSS y JS embebidos)
assets/
  logo-claro.png    Wordmark para tema claro (fondo transparente)
  logo-oscuro.png   Wordmark para tema oscuro (fondo transparente)
  lockup-claro.png  Lockup completo con los 5 pilares, fondo blanco
  lockup-oscuro.png Lockup completo con los 5 pilares, fondo oscuro
  favicon.png
  demo.mp4          Vídeo vertical 1080x1920, 1:48 (9,7 MB)
  demo-poster.jpg   Póster del vídeo
vercel.json         Cabeceras y caché
robots.txt
```

## Ver en local

```bash
python3 -m http.server 8080
# http://localhost:8080
```

## Qué toca editar

| Qué | Dónde |
|---|---|
| Precios | Sección 13. Atributos `data-mes` y `data-anual` de cada `.plan__precio b` |
| Features de cada plan | Los `<ul>` dentro de cada `<article class="plan">` |
| Descuento anual | El `<span class="chip">−20 %</span>` del conmutador |
| Colores y tipografías | Bloque `:root` / `[data-tema="oscuro"]` al principio del `<style>` |
| Textos de seguridad | Sección 14, marcados con `‹por confirmar›` |
| Enlaces de "Entrar" / "Empezar gratis" | Buscar `href="#"` |

## Sistema de diseño

Las variables CSS están extraídas de la plataforma (metododev.rkpanel.com):
violeta `#6c5ce7` como acento, teal `#00b8a0` secundario, oro para premium,
`Space Grotesk` para interfaz y `Montserrat` para titulares. Tema claro/oscuro
vía `data-tema` en `<html>`, con persistencia en `localStorage`.
