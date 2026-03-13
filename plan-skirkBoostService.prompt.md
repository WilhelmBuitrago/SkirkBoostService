# Ajuste de alcance: carrito temporal

## Reglas del carrito

- El carrito no debe persistirse en base de datos.
- La informacion del carrito es temporal y se mantiene solo durante la sesion activa.
- Al cerrar sesion o expirar la sesion, el carrito se limpia.

## Datos permitidos (solo estos)

- Pedidos agregados
- Precio por pedido
- Subtotal
- Total en COP
- Total en USD
- Metodo de contacto
- Metodo de pago

## Valores permitidos

- `metodoContacto`: `tiktok`, `instagram`, `discord`
- `metodoPago`: `nequi`, `paypal`

## Validaciones

- Validar opciones permitidas en frontend y backend.
- Si llega un valor fuera de lista, responder `400 Bad Request`.
- No crear tablas `orders`, `order_items` ni `cart_items` para este alcance.

## Impacto en arquitectura

- Postgres queda para usuarios, roles y configuracion administrativa (estado/precios/disponibilidad).
- Carrito y datos de contacto/pago se gestionan en sesion (`express-session`) de forma temporal.
