# Subir a GitHub y publicar en Vercel

El repo ya está inicializado y con el primer commit hecho en esta carpeta
(`~/Inmoprop/web`). Solo falta conectarlo con GitHub y con Vercel.

---

## 1. Crear el repo en GitHub

### Opción A — con GitHub CLI (lo más rápido)

```bash
cd ~/Inmoprop/web

# solo la primera vez en este Mac:
brew install gh
gh auth login          # elige GitHub.com → HTTPS → autenticar en el navegador

gh repo create inmoprop-web --private --source=. --remote=origin --push
```

Con eso el repo queda creado y subido. Cambia `--private` por `--public` si lo quieres abierto.

### Opción B — a mano

1. Entra en https://github.com/new
2. Nombre: `inmoprop-web` · **no** marques "Add a README" ni "Add .gitignore" (ya los tienes)
3. Crear repositorio
4. En la terminal:

```bash
cd ~/Inmoprop/web
git remote add origin https://github.com/TU-USUARIO/inmoprop-web.git
git push -u origin main
```

Si te pide contraseña, GitHub ya no las acepta: usa un **Personal Access Token**
(github.com → Settings → Developer settings → Personal access tokens → Fine-grained →
permiso `Contents: Read and write`) y pégalo como contraseña.

---

## 2. Publicar en Vercel

1. Entra en https://vercel.com y accede **con tu cuenta de GitHub**
2. **Add New… → Project**
3. Importa `inmoprop-web`
4. En la pantalla de configuración **no toques nada**:
   - Framework Preset: `Other`
   - Build Command: vacío
   - Output Directory: vacío (o `.`)
   - Es HTML estático, no hay build
5. **Deploy**

En unos 20 segundos tendrás una URL tipo `inmoprop-web.vercel.app`.

### Alternativa por terminal

```bash
npm i -g vercel
cd ~/Inmoprop/web
vercel          # primer despliegue de prueba (preview)
vercel --prod   # a producción
```

---

## 3. Conectar el dominio

En Vercel: **Project → Settings → Domains → Add**, escribe `inmoprop.ai`
(y `www.inmoprop.ai`). Vercel te dirá qué poner en tu proveedor de DNS:

| Tipo | Nombre | Valor |
|---|---|---|
| A | `@` | `76.76.21.21` |
| CNAME | `www` | `cname.vercel-dns.com` |

O, si prefieres delegar todo el dominio, cambia los nameservers a los de Vercel.
El certificado HTTPS se emite solo en cuanto el DNS propaga (de minutos a unas horas).

---

## 4. A partir de ahí: cada cambio se publica solo

```bash
cd ~/Inmoprop/web
# editas index.html …
git add -A
git commit -m "Precios definitivos"
git push
```

Cada `push` a `main` despliega a producción automáticamente. Cada push a otra rama
genera una URL de preview para revisar antes de fusionar — útil justo para lo de los precios.

---

## Notas

- **El vídeo pesa 9,7 MB** y va dentro del repo. Está por debajo del límite de GitHub
  (100 MB por fichero) y Vercel lo sirve sin problema con caché de un año, ya configurada
  en `vercel.json`. Si más adelante añades más vídeos, pásalos a Vercel Blob o a un CDN
  en vez de al repo.
- **`vercel.json`** ya trae las cabeceras de caché y de seguridad. No hace falta tocarlo.
- **El original sin comprimir** (`Video-web.mp4`, 52 MB) se queda fuera del repo,
  en `~/Inmoprop`. Guárdalo: es el máster.
