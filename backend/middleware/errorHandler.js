const MYSQL_ERRORS = {
  ER_DUP_ENTRY: [409, "A record with these values already exists"],
  ER_NO_REFERENCED_ROW_2: [422, "A referenced record does not exist"],
  ER_ROW_IS_REFERENCED_2: [409, "This record is still referenced by other records"],
};

function notFound(req, res) {
  res.status(404).json({ error: { message: `Cannot ${req.method} ${req.originalUrl}` } });
}

function errorHandler(err, req, res, next) {
  if (MYSQL_ERRORS[err.code]) [err.status, err.message] = MYSQL_ERRORS[err.code];
  if (err.type === "entity.parse.failed") err.message = "The request body is not valid JSON";
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: {
      message: status >= 500 ? "Internal server error" : err.message,
      ...(err.details !== undefined && { details: err.details }),
    },
  });
}

module.exports = { notFound, errorHandler };