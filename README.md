# Skirk's Boost Service (Microservicios)

Proyecto reestructurado en 3 microservicios con Docker:

- `frontend`: App web SSR con EJS (catalogo, login UI, carrito, config UI).
- `api`: Backend Express (auth, roles, estado de plataforma, disponibilidad y precios).
- `database`: Servicio Postgres para login/usuarios con roles.

## Arquitectura

```text
Browser
	-> frontend (3000)
	-> api (4000)
	-> database (5432)
```

- El `frontend` consume `api`.
- `database` (Postgres) se usa para tabla `usuarios` (login y permisos).
- Estado de plataforma y precios administrables se persisten en archivos JSON editables. En Render se recomienda usar Disk con:
	- `RUNTIME_CONFIG_PATH=/var/data/runtime-config.json`
	- `ZONES_CONFIG_PATH=/var/data/exploration-zones.json`
	- `SERVICES_CONFIG_PATH=/var/data/services.json`
- `frontend/config` se mantiene para configuracion del frontend y referencia de assets del servicio frontend.
- Carrito y datos de checkout son temporales en `sessionStorage` del navegador.

## Despliegue en Render

- Se incluye `render.yaml` para desplegar servicios Docker independientes (`skirk-api`, `skirk-frontend`) y Postgres gestionado.
- El `docker-compose.yml` se mantiene para desarrollo local.
- Variables obligatorias en Render:
	- API: `DATABASE_URL`, `FRONTEND_ORIGIN`, `SESSION_SECRET`, `PEPPER`, `NODE_ENV=production`
	- Frontend: `API_BASE_URL`, `PUBLIC_API_BASE_URL`, `NODE_ENV=production`

Notas de session/cookies:
- En produccion la API configura cookies con `sameSite=none` y `secure=true` para compatibilidad cross-site (`credentials: include`).
- Se usa session store en PostgreSQL (`connect-pg-simple`) para evitar perdida de sesion en reinicios.

## Seguridad de contrasena

Se implementa con Argon2 + salt aleatorio + pepper:

1. Se genera `salt` aleatorio por usuario.
2. Se construye `password + salt + PEPPER`.
3. Se hashea con `argon2id`.
4. Se guardan `password_hash` y `password_salt` en `usuarios`.
5. `PEPPER` queda en variable de entorno y no se guarda en base de datos.

## Roles

- `usuario`: puede navegar el catalogo y usar carrito.
- `administrador`: todo lo de usuario + acceso a `/config`.

## Estados de plataforma

- `ACTIVA`: todos los servicios habilitados (indicador verde).
- `PARCIAL`: algunos servicios deshabilitados por checklist admin (indicador amarillo).
- `NO_ACTIVA`: no se aceptan nuevos servicios (indicador rojo).

## Carrito

- Icono en la parte superior derecha.
- Pagina `/carrito` con:
	- listado de items,
	- precio individual,
	- subtotal y total en COP y USD.
- Formulario temporal con:
	- contacto: `TikTok`, `Instagram`, `Discord`.
	- pago: `Nequi`, `PayPal`.

## Primer arranque

1. Crea `.env` desde `.env.example`.

2. Levanta contenedores:

```bash
docker compose up --build
```

3. Abre:

- Frontend: `http://localhost:3000`
- API health: `http://localhost:4000/health`

4. Crea administrador inicial en `http://localhost:3000/login` con el formulario de bootstrap.

## Estructura principal

```text
api/
	src/
		db/migrations/
		middleware/
		routes/
		services/
	config/
	data/
database/
	Dockerfile
	init/
frontend/
	config/
	public/
	views/
docker-compose.yml
render.yaml
```

## Endpoints API

- Auth:
	- `GET /auth/bootstrap-status`
	- `POST /auth/bootstrap-admin`
	- `POST /auth/register`
	- `POST /auth/login`
	- `POST /auth/logout`
	- `GET /auth/me`
- Catalogo:
	- `GET /catalog`
- Admin (requiere rol `administrador`):
	- `GET /admin/config`
	- `PUT /admin/status`
	- `PUT /admin/availability`
	- `PUT /admin/price`
