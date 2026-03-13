## Plan: Flujo Nuevo Login Registro y Checkout

Separar autenticación en páginas de Ingresar y Registrar, convertir el registro en 2 pasos (correo obligatorio primero, luego nombre de usuario + contactos), aplicar login mixto por rol (administrador entra por usuario, no administrador entra por correo), eliminar notificaciones al agregar al carrito, mover la confirmación al carrito con validaciones de sesión/perfil completo, y extender API/DB para persistir correo/contactos y soportar confirmación de orden con resumen mostrado en UI.

**Steps**
1. Fase 1 - Migraciones DB base: crear una migración nueva en `api/src/db/migrations` para agregar `email` único requerido a futuro en `usuarios` y crear tabla de contactos de usuario (1:N) con tipo permitido (`whatsapp`, `tiktok`, `discord`, `instagram`), valor y bandera de contacto principal. También crear tabla de órdenes/confirmaciones para almacenar snapshot de servicios, contacto elegido y método de pago. *Bloquea fases 2 y 4*.
2. Fase 2 - Endpoints de autenticación: actualizar `POST /auth/register` para flujo por etapas (paso 1: correo + password temporal/session token; paso 2: nombre de usuario + contactos), o exponer dos endpoints (`/auth/register/start` y `/auth/register/complete`) manteniendo validación fuerte de mínimo 1 contacto. Ajustar `POST /auth/login` para login mixto por identificador (`correo` o `usuario`) con validación por rol: si el usuario es `administrador` solo permite login por `usuario`; si es `usuario` normal solo permite login por `correo`; y enriquecer sesión con estado de perfil completo. *Depende de 1*.
3. Fase 2 - Política usuarios incompletos: en `GET /auth/me` incluir flags explícitas (`profileComplete`, `missingFields`) para que frontend bloquee confirmación de carrito cuando falten datos. Si usuario existente no tiene correo/contactos válidos, marcarlo incompleto y no permitir confirmar compra. *Depende de 1 y 2*.
4. Fase 3 - Rutas SSR frontend: separar vistas en `Ingresar` y `Registrar` agregando ruta dedicada de registro y ruta de segundo paso de registro desde `frontend/server.js`. Mantener `/login` solo para ingresar. *Puede avanzar en paralelo con 2 después de definir contratos API*.
5. Fase 3 - UI Login: en la vista de login dejar formulario de ingreso con campo único de identificador (`Correo o usuario`) para soportar login mixto, manteniendo la regla de backend por rol (administrador por usuario, no administrador por correo), y añadir texto arriba del botón: `¿Aún no tienes una cuenta? Regístrate aquí` enlazando a la primera pantalla de registro. Validar copy exacto y ubicación solicitada.
6. Fase 3 - UI Registro 2 pasos: pantalla 1 pide correo obligatorio (y password); al continuar redirige a pantalla 2 para `Nombre de usuario` y lista de plataformas de contacto donde se puedan agregar varias entradas, exigiendo mínimo una entre WhatsApp/TikTok/Discord/Instagram. Persistir datos temporales entre pasos de forma segura (estado de sesión o token temporal, no solo memoria de página).
7. Fase 4 - Carrito UX: eliminar alertas/notificaciones al agregar productos al carrito y retirar botón `Confirmar servicio` de vistas de detalle (el flujo queda solo en agregar al carrito). En carrito, renombrar botón `Guardar temporalmente` a `Confirmar`.
8. Fase 4 - Confirmación en carrito: al cargar carrito, consultar sesión (`/auth/me`) para habilitar/deshabilitar botón Confirmar. Si no está logeado o perfil incompleto, mantener botón deshabilitado y mostrar mensaje de acción (iniciar sesión/completar perfil).
9. Fase 4 - Contacto y pago en checkout: poblar selector de contacto con los contactos del usuario y seleccionar por defecto el primero/principal. Al confirmar, enviar orden a API y mostrar dentro de la página un resumen textual con servicios elegidos, correo, usuario, contacto seleccionado y método de pago (sin Notification API del navegador).
10. Fase 5 - Integración y compatibilidad: adaptar scripts de frontend (`auth.js`, `cart.js`, `zone-detail.js`, potencialmente nuevos `register-step1.js` y `register-step2.js`) y rutas API para que el contrato de datos quede coherente extremo a extremo. Añadir controles de error para duplicados de correo/usuario y contactos inválidos.
11. Fase 6 - Validación: ejecutar pruebas manuales y smoke tests de rutas para login, registro en 2 pasos, agregar al carrito sin alertas, confirmación bloqueada sin sesión, confirmación bloqueada con perfil incompleto, y confirmación exitosa con resumen visible en UI.

**Relevant files**
- `c:\Users\wilhe\Documents\SkirkBoostService\api\src\db\migrations\001_create_usuarios.sql` - referencia del esquema actual de usuarios para migración incremental.
- `c:\Users\wilhe\Documents\SkirkBoostService\api\src\db\migrations\002_create_session_table.sql` - patrón de migraciones existente.
- `c:\Users\wilhe\Documents\SkirkBoostService\api\src\routes\authRoutes.js` - login/register actual a transformar para correo + perfil completo.
- `c:\Users\wilhe\Documents\SkirkBoostService\api\src\middleware\auth.js` - guardas de sesión para checkout/orden.
- `c:\Users\wilhe\Documents\SkirkBoostService\api\src\index.js` - registro de nuevas rutas (órdenes/checkout).
- `c:\Users\wilhe\Documents\SkirkBoostService\frontend\server.js` - rutas SSR para separar ingresar/registrar y segundo paso.
- `c:\Users\wilhe\Documents\SkirkBoostService\frontend\views\login.ejs` - dejar solo ingresar + CTA a registro.
- `c:\Users\wilhe\Documents\SkirkBoostService\frontend\views\cart.ejs` - botón Confirmar, selector de contacto y mensajes de bloqueo.
- `c:\Users\wilhe\Documents\SkirkBoostService\frontend\views\zone-detail.ejs` - retirar botón Confirmar servicio.
- `c:\Users\wilhe\Documents\SkirkBoostService\frontend\public\js\auth.js` - cambios de payload/login por correo y redirecciones de registro.
- `c:\Users\wilhe\Documents\SkirkBoostService\frontend\public\js\cart.js` - bloquear/permitir confirmación, resumen textual final, consumo de contactos.
- `c:\Users\wilhe\Documents\SkirkBoostService\frontend\public\js\main.js` - eliminar alertas al agregar al carrito.
- `c:\Users\wilhe\Documents\SkirkBoostService\frontend\public\js\zone-detail.js` - eliminar alertas y flujo de confirmación local.
- `c:\Users\wilhe\Documents\SkirkBoostService\frontend\public\css\styles.css` - ajustes visuales para separación de ingresar/registrar y estado disabled.

**Verification**
1. Ejecutar migraciones en entorno local y verificar nuevas columnas/tablas con consultas SQL simples (`usuarios`, contactos, órdenes).
2. Probar `POST /auth/register/start` y `POST /auth/register/complete` (o endpoint final definido) validando: correo obligatorio, username obligatorio en paso 2, mínimo 1 contacto.
3. Probar `POST /auth/login` con matriz por rol e identificador: admin con `usuario` (ok), admin con `correo` (rechazado), usuario normal con `correo` (ok), usuario normal con `usuario` (rechazado); además revisar `GET /auth/me` con `profileComplete`.
4. Navegar `/login` y comprobar CTA `¿Aún no tienes una cuenta? Regístrate aquí` arriba del botón de ingresar y navegación a registro.
5. Completar registro 2 pasos con 1 y con múltiples contactos; confirmar que el primer contacto queda por defecto.
6. Agregar servicios al carrito y confirmar que no aparece alerta/notificación al agregar.
7. Verificar que el botón `Confirmar` en carrito queda deshabilitado si no hay sesión o perfil incompleto.
8. Confirmar carrito con sesión válida y perfil completo, y validar que aparece resumen textual in-page con servicios, correo, usuario, contacto elegido y método de pago.
9. Revisar regresión rápida: logout/login admin, navegación catálogo, carrito persistente y carga de precios sin romper comportamiento existente.

**Decisions**
- Login será mixto por rol: administrador por `usuario`; usuario normal por `correo`.
- La notificación final será un texto/mensaje dentro de la página, no Notification API del navegador.
- Usuarios existentes sin datos requeridos quedan bloqueados para confirmar carrito hasta completar perfil.
- Se elimina el patrón de confirmar desde página de servicio; toda confirmación pasa por carrito.

**Further Considerations**
1. Definir si el método de pago permitido seguirá restringido a los actuales (`Nequi`, `PayPal`) o si se ampliará en la misma iteración.
2. Definir si se desea migración asistida para usuarios existentes (pantalla de completar perfil al login) en esta tarea o en una siguiente.
3. Confirmar si se mantiene unicidad de `usuario` histórico o si se permitirá cambiarlo tras registro para soporte futuro.