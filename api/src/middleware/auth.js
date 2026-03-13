function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'No autenticado' });
  }

  return next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'No autenticado' });
  }

  if (req.session.user.role !== 'administrador') {
    return res.status(403).json({ error: 'Acceso denegado' });
  }

  return next();
}

module.exports = {
  requireAuth,
  requireAdmin
};
