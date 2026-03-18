# Skirk's Boost Service (Microservicios)

Proyecto reestructurado en 4 microservicios con Docker:

- `frontend`: App web SSR con EJS (catalogo, login UI, carrito, config UI).
- `api`: Backend Express (auth, roles, catalogo, ordenes v1, retries y scheduler).
- `database`: Servicio Postgres para login/usuarios con roles.
- `DisBot`: Servicio desacoplado de notificacion DM (sin logica de negocio).

## Arquitectura

```text
Browser
	-> frontend (3000)
	-> api (4000)
	-> DisBot (5000)
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
	- API (DisBot): `DISBOT_BASE_URL`, `DISBOT_SHARED_SECRET`, `DISBOT_TIMEOUT_MS`
	- API (Orders v1): `ORDER_NOTIFY_MAX_RETRIES`, `ORDER_NOTIFY_RETRY_BASE_SECONDS`, `ORDER_NOTIFY_BATCH_SIZE`, `ORDER_NOTIFY_SCHEDULER_INTERVAL_SECONDS`, `ORDER_NOTIFY_RETENTION_DAYS`
	- API (bootstrap admin por entorno): `ADMIN_BOOTSTRAP_ENABLED=true`, `ADMIN_BOOTSTRAP_USER`, `ADMIN_BOOTSTRAP_PASSWORD`
	- Frontend: `API_BASE_URL`, `PUBLIC_API_BASE_URL`, `BOOT_WAKEUP_URL`, `BOOT_WAKEUP_DISBOT_URL`, `NODE_ENV=production`
	- DisBot: `DISCORD_BOT_TOKEN`, `USER_ID`, `API_SHARED_SECRET`, `DISBOT_PORT`, `DISBOT_SYNC_ONLY=true`

Wake-up de API en cold start:
- El frontend intenta despertar la API al cargar la pantalla de boot con `BOOT_WAKEUP_URL`.
- El frontend tambien despierta DisBot con `BOOT_WAKEUP_DISBOT_URL`.
- Si API o DisBot no responden en el intento inicial, mantiene la barra actual y reintenta en 4 checkpoints visuales (25%, 50%, 75%, 100%).
- Solo cuando API y DisBot responden, la barra se completa de inmediato y luego se valida catalogo via `/boot/availability` para continuar al destino solicitado.

Confirmacion de pedido con DisBot:
- El frontend confirma pedido contra API.
- La API persiste la orden y su registro de notificacion en PostgreSQL.
- La API notifica a DisBot para enviar DM al `USER_ID` configurado.
- Si la notificacion falla temporalmente, la API agenda retry con backoff exponencial.
- DisBot solo responde `success=true/false` y `error` opcional.

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
	- total USD de orden calculado como suma de conversiones finales por servicio (no desde suma global COP).
- Formulario temporal con:
	- contacto: `TikTok`, `Instagram`, `Discord`.
	- pago: `Nequi`, `PayPal`.

## Regla COP a USD

- La tasa base es `1 USD = 3694 COP` y se configura unicamente en API mediante `USD_VALUE`.
- Conversion final por servicio:
	1. `N = COP / 3694`
	2. `(N + 0.30) / 0.946`
	3. redondeo hacia arriba (`ceil`)
	4. sumar `1 USD`
- Para ordenes con varios servicios: se convierte cada servicio por separado y luego se suman los USD finales.
- El frontend no define `USD_VALUE`; cuando necesita la tasa o montos USD, los consume desde el backend/catalogo.

## Primer arranque

1. Crea `.env` desde `.env.example`.

2. Levanta contenedores:

```bash
docker compose up --build
```

3. Abre:

- Frontend: `http://localhost:3000`
- API health: `http://localhost:4000/health`

4. El API crea automaticamente el administrador inicial desde variables de entorno cuando `ADMIN_BOOTSTRAP_ENABLED=true`.

5. Inicia sesion en `http://localhost:3000/login` con `ADMIN_BOOTSTRAP_USER` y `ADMIN_BOOTSTRAP_PASSWORD`.

Nota: la creacion es idempotente. Si ya existe un usuario con rol `administrador`, no se crea otro.

## Ordenes v1 y notificaciones

- Namespace obligatorio: `/api/v1/...`
- API centraliza:
	- creacion de orden
	- idempotencia
	- estados de orden
	- retries
	- scheduler y limpieza
- DisBot solo envia DM y responde:

```json
{
  "success": true
}
```

o

```json
{
  "success": false,
  "error": "optional"
}
```

Estados de orden v1:
- `PENDING`
- `NOTIFIED`
- `IN_PROGRESS`
- `COMPLETED`
- `FAILED_NOTIFY`
- `CANCELLED`

Tabla de notificaciones:
- `order_notifications` con `status` (`pending`, `retry`, `sent`, `failed`), `retry_count`, `next_retry_at`, `last_error`, `completed_at`.

Query de scheduler (API):

```sql
SELECT n.order_id
FROM order_notifications n
WHERE n.status = 'retry'
AND n.next_retry_at <= NOW()
LIMIT $1
FOR UPDATE SKIP LOCKED;
```

Retencion diaria:

```sql
DELETE FROM order_notifications
WHERE status IN ('sent', 'failed')
AND completed_at < NOW() - INTERVAL '7 days';
```

## Frontend por servicios

- Home (`/`) muestra 6 opciones principales:
	- Exploracion
	- Farmeo de deseos
	- Realizacion de misiones
	- Farmeo
	- Ascension de personajes
	- Mantenimiento de cuenta
- Cada bloque abre su pagina dedicada.
- El estado de plataforma se muestra en el header junto a `Skirk Boost`.

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
	- `POST /api/v1/auth/register/start`
	- `POST /api/v1/auth/register/complete`
	- `POST /api/v1/auth/login`
	- `POST /api/v1/auth/logout`
	- `GET /api/v1/auth/me`
- Catalogo:
	- `GET /api/v1/catalog`
- Ordenes v1:
	- `POST /api/v1/orders`
	- `GET /api/v1/orders`
	- `GET /api/v1/orders/:orderId`
	- `PATCH /api/v1/orders/:orderId/status` (admin)
	- `GET /api/v1/orders/notifications/retries/active` (admin)
	- `GET /api/v1/orders/notifications/failures/final` (admin)
- Admin config (requiere rol `administrador`):
	- `GET /api/v1/admin/config`
	- `PUT /api/v1/admin/status`
	- `PUT /api/v1/admin/availability`
	- `PUT /api/v1/admin/price`

## Prueba de integracion v1

Con servicios levantados (`database`, `disbot`, `api`):

```bash
npm --prefix api run test:orders:v1
```

El script valida:
- creacion de orden
- idempotencia
- `UNIQUE(order_id)` en notificaciones
- ejecucion de retry batch
- limpieza por retencion
