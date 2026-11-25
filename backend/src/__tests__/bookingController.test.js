/**
 * Tests du contrôleur de réservation (bookingController)
 *
 * Tests "unitaires de contrôleur" : on appelle directement les fonctions
 * du contrôleur avec une fausse requête (req) et une fausse réponse (res).
 * La base de données est remplacée par des "mocks" (fausses versions des
 * modèles) : on décide nous-mêmes de ce qu'elle renvoie, pour tester
 * chaque cas (bateau introuvable, dates déjà prises, etc.).
 */

// ---------- Mocks (fausses versions des dépendances) ----------
const mockTransaction = {
  commit: jest.fn(),
  rollback: jest.fn(),
  LOCK: { UPDATE: "UPDATE" },
};

jest.mock("../models", () => ({
  sequelize: { transaction: jest.fn(() => Promise.resolve(mockTransaction)) },
  Booking: { findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn(), create: jest.fn() },
  Boat: { findByPk: jest.fn() },
  Availability: { findOne: jest.fn() },
  Payment: { findOne: jest.fn() },
  User: {},
}));

const mockStripeRefund = jest.fn();
jest.mock("stripe", () => () => ({ refunds: { create: mockStripeRefund } }));

jest.mock("../services/paypalService", () => ({ refundCapture: jest.fn() }));

const { Booking, Boat, Availability, Payment } = require("../models");
const paypalService = require("../services/paypalService");
const controller = require("../controllers/bookingController");

// Fausse réponse Express : on enregistre le code HTTP et le JSON renvoyés.
const mockRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

// Date au format AAAA-MM-JJ, décalée de n jours par rapport à aujourd'hui.
const dans = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

beforeEach(() => jest.clearAllMocks());

// =====================================================================
describe("createBooking : créer une réservation", () => {
  const bateau = { id: 1, prixJour: 200, capacite: 6, userId: 2 };
  const corps = { boatId: 1, dateDebut: "2027-07-01", dateFin: "2027-07-04", nombrePersonnes: 2 };

  test("cas nominal : 201, montant et commission calculés, statut en_attente", async () => {
    Boat.findByPk.mockResolvedValue(bateau);
    Availability.findOne.mockResolvedValue({ id: 1 });
    Booking.findOne.mockResolvedValue(null);
    Booking.create.mockImplementation(async (data) => ({ id: 10, ...data }));
    const res = mockRes();

    await controller.createBooking({ body: corps, user: { id: 5 } }, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const cree = Booking.create.mock.calls[0][0];
    expect(cree.montantTotal).toBe(600); // 3 jours x 200 €
    expect(cree.commission).toBe(60); // 10 % de commission SailingLoc
    expect(cree.statut).toBe("en_attente");
    expect(cree.userId).toBe(5);
    expect(mockTransaction.commit).toHaveBeenCalled();
  });

  test("champs obligatoires manquants : 400", async () => {
    const res = mockRes();
    await controller.createBooking({ body: { boatId: 1 }, user: { id: 5 } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockTransaction.rollback).toHaveBeenCalled();
  });

  test("date de fin avant la date de début : 400", async () => {
    const res = mockRes();
    await controller.createBooking(
      { body: { ...corps, dateDebut: "2027-07-04", dateFin: "2027-07-01" }, user: { id: 5 } },
      res
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("bateau introuvable : 404", async () => {
    Boat.findByPk.mockResolvedValue(null);
    const res = mockRes();
    await controller.createBooking({ body: corps, user: { id: 5 } }, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test("trop de voyageurs pour la capacité du bateau : 400", async () => {
    Boat.findByPk.mockResolvedValue(bateau);
    const res = mockRes();
    await controller.createBooking({ body: { ...corps, nombrePersonnes: 12 }, user: { id: 5 } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("bateau non disponible sur la période : 400", async () => {
    Boat.findByPk.mockResolvedValue(bateau);
    Availability.findOne.mockResolvedValue(null);
    const res = mockRes();
    await controller.createBooking({ body: corps, user: { id: 5 } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(Booking.create).not.toHaveBeenCalled();
  });

  test("dates déjà réservées par quelqu'un d'autre (double réservation) : 409", async () => {
    Boat.findByPk.mockResolvedValue(bateau);
    Availability.findOne.mockResolvedValue({ id: 1 });
    Booking.findOne.mockResolvedValue({ id: 99 });
    const res = mockRes();
    await controller.createBooking({ body: corps, user: { id: 5 } }, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(Booking.create).not.toHaveBeenCalled();
    expect(mockTransaction.rollback).toHaveBeenCalled();
  });

  test("le bateau est verrouillé pendant la transaction (anti double réservation)", async () => {
    Boat.findByPk.mockResolvedValue(bateau);
    Availability.findOne.mockResolvedValue({ id: 1 });
    Booking.findOne.mockResolvedValue(null);
    Booking.create.mockResolvedValue({ id: 10 });
    await controller.createBooking({ body: corps, user: { id: 5 } }, mockRes());
    expect(Boat.findByPk).toHaveBeenCalledWith(1, expect.objectContaining({ lock: "UPDATE" }));
  });

  test("erreur base de données : 500 et annulation de la transaction", async () => {
    Boat.findByPk.mockRejectedValue(new Error("connexion perdue"));
    const res = mockRes();
    await controller.createBooking({ body: corps, user: { id: 5 } }, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(mockTransaction.rollback).toHaveBeenCalled();
  });
});

// =====================================================================
describe("respondToBookingRequest : le propriétaire accepte ou refuse", () => {
  const demande = (statut = "en_attente") => ({
    statut,
    Boat: { userId: 2 },
    save: jest.fn(),
  });

  test("accepter : statut acceptee", async () => {
    const booking = demande();
    Booking.findByPk.mockResolvedValue(booking);
    const res = mockRes();
    await controller.respondToBookingRequest({ params: { id: 1 }, body: { action: "accepter" }, user: { id: 2 } }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(booking.statut).toBe("acceptee");
    expect(booking.save).toHaveBeenCalled();
  });

  test("refuser : statut annulee", async () => {
    const booking = demande();
    Booking.findByPk.mockResolvedValue(booking);
    await controller.respondToBookingRequest({ params: { id: 1 }, body: { action: "refuser" }, user: { id: 2 } }, mockRes());
    expect(booking.statut).toBe("annulee");
  });

  test("action invalide : 400", async () => {
    const res = mockRes();
    await controller.respondToBookingRequest({ params: { id: 1 }, body: { action: "peut-etre" }, user: { id: 2 } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("réservation introuvable : 404", async () => {
    Booking.findByPk.mockResolvedValue(null);
    const res = mockRes();
    await controller.respondToBookingRequest({ params: { id: 1 }, body: { action: "accepter" }, user: { id: 2 } }, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test("un autre utilisateur que le propriétaire : 403", async () => {
    Booking.findByPk.mockResolvedValue(demande());
    const res = mockRes();
    await controller.respondToBookingRequest({ params: { id: 1 }, body: { action: "accepter" }, user: { id: 7 } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test("demande déjà traitée : 400", async () => {
    Booking.findByPk.mockResolvedValue(demande("acceptee"));
    const res = mockRes();
    await controller.respondToBookingRequest({ params: { id: 1 }, body: { action: "refuser" }, user: { id: 2 } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

// =====================================================================
describe("cancelBooking : annuler une réservation", () => {
  const resa = (over = {}) => ({
    id: 1, userId: 5, statut: "acceptee", dateDebut: dans(10), save: jest.fn(), ...over,
  });

  test("annulation sans paiement : 200, statut annulee", async () => {
    const booking = resa();
    Booking.findByPk.mockResolvedValue(booking);
    Payment.findOne.mockResolvedValue(null);
    const res = mockRes();
    await controller.cancelBooking({ params: { id: 1 }, user: { id: 5, role: "locataire" } }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(booking.statut).toBe("annulee");
  });

  test("annulation avec paiement Stripe : remboursement puis statut rembourse", async () => {
    const booking = resa({ statut: "confirmee" });
    const paiement = { methode: "stripe", referenceTransaction: "pi_123", statut: "paye", save: jest.fn() };
    Booking.findByPk.mockResolvedValue(booking);
    Payment.findOne.mockResolvedValue(paiement);
    mockStripeRefund.mockResolvedValue({ id: "re_1" });
    const res = mockRes();
    await controller.cancelBooking({ params: { id: 1 }, user: { id: 5, role: "locataire" } }, res);
    expect(mockStripeRefund).toHaveBeenCalledWith({ payment_intent: "pi_123" });
    expect(paiement.statut).toBe("rembourse");
    expect(booking.statut).toBe("annulee");
  });

  test("annulation avec paiement PayPal : remboursement PayPal", async () => {
    Booking.findByPk.mockResolvedValue(resa({ statut: "confirmee" }));
    Payment.findOne.mockResolvedValue({ methode: "paypal", referenceTransaction: "cap_1", save: jest.fn() });
    await controller.cancelBooking({ params: { id: 1 }, user: { id: 5, role: "locataire" } }, mockRes());
    expect(paypalService.refundCapture).toHaveBeenCalledWith("cap_1");
  });

  test("remboursement en échec : 502 et la réservation n'est PAS annulée", async () => {
    const booking = resa({ statut: "confirmee" });
    Booking.findByPk.mockResolvedValue(booking);
    Payment.findOne.mockResolvedValue({ methode: "stripe", referenceTransaction: "pi_1", save: jest.fn() });
    mockStripeRefund.mockRejectedValue(new Error("Stripe indisponible"));
    const res = mockRes();
    await controller.cancelBooking({ params: { id: 1 }, user: { id: 5, role: "locataire" } }, res);
    expect(res.status).toHaveBeenCalledWith(502);
    expect(booking.statut).toBe("confirmee");
  });

  test("moins de 48 h avant le départ : 400 pour un locataire", async () => {
    Booking.findByPk.mockResolvedValue(resa({ dateDebut: dans(1) }));
    const res = mockRes();
    await controller.cancelBooking({ params: { id: 1 }, user: { id: 5, role: "locataire" } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("moins de 48 h avant le départ : autorisé pour un admin", async () => {
    Booking.findByPk.mockResolvedValue(resa({ dateDebut: dans(1) }));
    Payment.findOne.mockResolvedValue(null);
    const res = mockRes();
    await controller.cancelBooking({ params: { id: 1 }, user: { id: 1, role: "admin" } }, res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test("réservation d'un autre utilisateur : 403", async () => {
    Booking.findByPk.mockResolvedValue(resa());
    const res = mockRes();
    await controller.cancelBooking({ params: { id: 1 }, user: { id: 8, role: "locataire" } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test("déjà annulée : 400", async () => {
    Booking.findByPk.mockResolvedValue(resa({ statut: "annulee" }));
    const res = mockRes();
    await controller.cancelBooking({ params: { id: 1 }, user: { id: 5, role: "locataire" } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("terminée : 400", async () => {
    Booking.findByPk.mockResolvedValue(resa({ statut: "terminee" }));
    const res = mockRes();
    await controller.cancelBooking({ params: { id: 1 }, user: { id: 5, role: "locataire" } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("introuvable : 404", async () => {
    Booking.findByPk.mockResolvedValue(null);
    const res = mockRes();
    await controller.cancelBooking({ params: { id: 1 }, user: { id: 5, role: "locataire" } }, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

// =====================================================================
describe("Consultation des réservations", () => {
  test("getMyBookings : renvoie les réservations de l'utilisateur connecté", async () => {
    Booking.findAll.mockResolvedValue([{ id: 1 }]);
    const res = mockRes();
    await controller.getMyBookings({ user: { id: 5 } }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(Booking.findAll.mock.calls[0][0].where).toEqual({ userId: 5 });
  });

  test("getBookingById : 403 si la réservation appartient à un autre", async () => {
    Booking.findByPk.mockResolvedValue({ userId: 9 });
    const res = mockRes();
    await controller.getBookingById({ params: { id: 1 }, user: { id: 5, role: "locataire" } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test("getBookingById : 200 pour le propriétaire de la réservation", async () => {
    Booking.findByPk.mockResolvedValue({ userId: 5 });
    const res = mockRes();
    await controller.getBookingById({ params: { id: 1 }, user: { id: 5, role: "locataire" } }, res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test("getOwnerBookingRequests : filtre sur les bateaux du propriétaire", async () => {
    Booking.findAll.mockResolvedValue([]);
    const res = mockRes();
    await controller.getOwnerBookingRequests({ user: { id: 2 } }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(Booking.findAll.mock.calls[0][0].include[0].where).toEqual({ userId: 2 });
  });

  test("getBookedDates : renvoie seulement les dates, sans donnée personnelle", async () => {
    Booking.findAll.mockResolvedValue([{ dateDebut: "2027-07-01", dateFin: "2027-07-04", userId: 5 }]);
    const res = mockRes();
    await controller.getBookedDates({ params: { boatId: 1 } }, res);
    expect(res.json).toHaveBeenCalledWith({ bookedDates: [{ dateDebut: "2027-07-01", dateFin: "2027-07-04" }] });
  });
});
