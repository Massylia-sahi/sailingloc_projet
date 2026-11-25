// Variables d'environnement utilisees uniquement pendant les tests Jest.
// Elles evitent que les tests dependent d'un fichier .env local
// (cause des 8 echecs : "secretOrPrivateKey must have a value").
// Valeurs factices : aucune vraie cle ici.
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_jest_sailingloc";
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "test_refresh_secret_jest";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
