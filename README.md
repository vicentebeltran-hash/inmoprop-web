# Inmoprop AI — landing

Web estática de una sola página. Sin build, sin dependencias: `index.html` + ``.

## Estructura

```
index.html          La landing completa (CSS y JS embebidos)
logo-claro.png      Wordmark para tema claro (fondo transparente)
logo-oscuro.png     Wordmark para tema oscuro (fondo transparente)
lockup-claro.png    Lockup completo con los 5 pilares, fondo blanco
lockup-oscuro.png   Lockup completo con los 5 pilares, fondo oscuro
favicon.png
demo.mp4            Vídeo vertical 1080x1920, 1:48 (9,7 MB)
demo-poster.jpg     Póster del vídeo
vercel.json         Cabeceras y caché
robots.txt
```

Todo vive en la raíz, sin subcarpetas: así se puede subir a GitHub arrastrando
los ficheros desde el navegador, sin tener que crear carpetas.

## Ver en local

```bash
python3 -m http.server 8080
# http://localhost:8080
```

## Qué toca editar

| Qué | Dónde |
|---|---|
| Precios de las tarjetas | Sección 13. Atributos `data-mes` y `data-anual` de cada `.plan__precio b` |
| Reglas de la calculadora | Bloque `CFG` del `<script>` final: `multiBase`, `agentesIncl`, `extraBase`, `descuento`, `suelo`, `factorAnual` |
| Features de cada plan | Los `<ul>` dentro de cada `<article class="plan">` |
| Descuento anual | `CFG.factorAnual` + el `<span class="chip">−20 %</span>` del conmutador + los `data-anual` |
| Plataformas del roadmap | Sección 9, tarjetas `.plat--hoy` y `.plat--futuro` |
| Colores y tipografías | Bloque `:root` / `[data-tema="oscuro"]` al principio del `<style>` |
| Textos de seguridad | Sección 14, marcados con `‹por confirmar›` |
| Enlaces de "Entrar" / "Empezar gratis" | Buscar `href="#"` |

## Modelo de precios implementado

- **Agente** 49 €/mes · un usuario
- **Gerente** 98 €/mes · un usuario con los dos roles; es la licencia que permite agrupar
- **Multi** 179 €/mes · 1 Gerente + 3 Agentes incluidos. Cada agente adicional a partir del
  cuarto cuesta un 5 % menos que el anterior (acumulativo), con suelo de 29 €/licencia.
  La calculadora de la sección 13 lo resuelve en vivo y compara contra licencias sueltas.
- Facturación anual: −20 % sobre todo.

## Sistema de diseño

Las variables CSS están extraídas de la plataforma (metododev.rkpanel.com):
violeta `#6c5ce7` como acento, teal `#00b8a0` secundario, oro para premium,
`Space Grotesk` para interfaz y `Montserrat` para titulares. Tema claro/oscuro
vía `data-tema` en `<html>`, con persistencia en `localStorage`.
