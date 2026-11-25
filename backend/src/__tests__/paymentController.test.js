/**
 * Tests du contrôleur de paiement (paymentController)
 *
 * Stripe, PayPal, la base de données, les emails et la génération de
 * contrat sont remplacés par des mocks : aucun vrai paiement, aucun vrai
 * email. On vérifie la logique de SailingLoc : qui a le droit de payer,
 * quand, et ce qui se passe après un paiement réussi.
 */

const mockSessionsRetrieve = jest.fn();
const mockConstructEvent = jest.fn();
jest.mock("stripe", () => () => ({
  checkout: { sessions: { retrieve: mockSessionsRetrieve } },
  webhooks: { constructEvent: mockConstructEvent },
}));

jest.mock("../models", () => ({
  Payment: { findOne: jest.fn(), create: jest.fn(), findAll: jest.fn() },
  Booking: { findByPk: jest.fn() },
  Contract: { findOne: jest.fn() },
  Boat: {},
  User: {},
}));

jest.mock("../services/emailService", () => ({
  sendPaymentConfirmation: jest.fn(),
  sendOwnerBookingNotification: jest.fn(),
}));
jest.mock("../services/stripeService", () => ({ createCheckoutSession: jest.fn() }));
jest.mock("../services/paypalService", () => ({ createOrder: jest.fn(), captureOrder: jest.fn() }));
jest.mock("../controllers/contractController", () => ({ generateContractForBooking: jest.fn() }));

const { Payment, Booking, Contract } = require("../models");
const { sendPaymentConfirmation, sendOwnerBookingNotification } = require("../services/emailService");
const { createCheckoutSession } = require("../services/stripeService");
const paypalService = require("../services/paypalService");
const contractController = require("../controllers/contractController");
const controller = require("../controllers/paymentController");

const mockRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  res.send = jest.fn(() => res);
  return res;
};

// Réservation factice avec locataire et propriétaire (pour les emails).
const resa = (over = {}) => ({
  id: 1,
  userId: 5,
  statut: "acceptee",
  montantTotal: 660,
  save: jest.fn(),
  User: { email: "locataire@test.fr" },
  Boat: { User: { email: "proprio@test.fr" } },
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

// =====================================================================
describe("createStripeSession : démarrer un paiement par carte", () => {
  test("réservation acceptée : 200 et URL de paiement Stripe", async () => {
    Booking.findByPk.mockResolvedValue(resa());
    createCheckoutSession.mockResolvedValue({ url: "https://checkout.stripe.com/x", id: "cs_1" });
    const res = mockRes();
    await controller.createStripeSession({ params: { bookingId: 1 }, user: { id: 5, role: "locataire" } }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ url: "https://checkout.stripe.com/x", sessionId: "cs_1" }));
  });

  test("réservation introuvable : 404", async () => {
    Booking.findByPk.mockResolvedValue(null);
    const res = mockRes();
    await controller.createStripeSession({ params: { bookingId: 1 }, user: { id: 5 } }, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test("payer la réservation de quelqu'un d'autre : 403", async () => {
    Booking.findByPk.mockResolvedValue(resa());
    const res = mockRes();
    await controller.createStripeSession({ params: { bookingId: 1 }, user: { id: 9, role: "locataire" } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  test.each(["confirmee", "annulee", "terminee"])("réservation %s : 400, pas de nouveau paiement", async (statut) => {
    Booking.findByPk.mockResolvedValue(resa({ statut }));
    const res = mockRes();
    await controller.createStripeSession({ params: { bookingId: 1 }, user: { id: 5, role: "locataire" } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

// =====================================================================
describe("confirmStripeSession : retour sur le site après paiement", () => {
  test("paiement réussi : paiement enregistré, réservation confirmée, contrat et emails", async () => {
    const booking = resa();
    mockSessionsRetrieve.mockResolvedValue({ id: "cs_1", payment_status: "paid", payment_intent: "pi_1", metadata: { bookingId: 1 } });
    Booking.findByPk.mockResolvedValue(booking);
    Payment.findOne.mockResolvedValue(null);
    contractController.generateContractForBooking.mockResolvedValue({ id: 3 });
    const res = mockRes();

    await controller.confirmStripeSession({ params: { sessionId: "cs_1" } }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(Payment.create).toHaveBeenCalledWith(expect.objectContaining({ methode: "stripe", statut: "paye", referenceTransaction: "pi_1", montant: 660 }));
    expect(booking.statut).toBe("confirmee");
    expect(contractController.generateContractForBooking).toHaveBeenCalledWith(1);
    expect(sendPaymentConfirmation).toHaveBeenCalled();
    expect(sendOwnerBookingNotification).toHaveBeenCalledWith("proprio@test.fr", booking);
  });

  test("session non payée : 400, rien n'est enregistré", async () => {
    mockSessionsRetrieve.mockResolvedValue({ payment_status: "unpaid" });
    const res = mockRes();
    await controller.confirmStripeSession({ params: { sessionId: "cs_1" } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(Payment.create).not.toHaveBeenCalled();
  });

  test("métadonnées manquantes : 400", async () => {
    mockSessionsRetrieve.mockResolvedValue({ payment_status: "paid", metadata: {} });
    const res = mockRes();
    await controller.confirmStripeSession({ params: { sessionId: "cs_1" } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("déjà confirmée (webhook passé avant) : pas de double paiement", async () => {
    mockSessionsRetrieve.mockResolvedValue({ payment_status: "paid", metadata: { bookingId: 1 } });
    Booking.findByPk.mockResolvedValue(resa({ statut: "confirmee" }));
    Contract.findOne.mockResolvedValue({ id: 3 });
    const res = mockRes();
    await controller.confirmStripeSession({ params: { sessionId: "cs_1" } }, res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ alreadyConfirmed: true }));
    expect(Payment.create).not.toHaveBeenCalled();
  });

  test("le contrat échoue : le paiement reste confirmé (pas de blocage)", async () => {
    const booking = resa();
    mockSessionsRetrieve.mockResolvedValue({ id: "cs_1", payment_status: "paid", metadata: { bookingId: 1 } });
    Booking.findByPk.mockResolvedValue(booking);
    Payment.findOne.mockResolvedValue(null);
    contractController.generateContractForBooking.mockRejectedValue(new Error("PDF"));
    const res = mockRes();
    await controller.confirmStripeSession({ params: { sessionId: "cs_1" } }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(booking.statut).toBe("confirmee");
  });

  test("Stripe indisponible : 500", async () => {
    mockSessionsRetrieve.mockRejectedValue(new Error("Stripe down"));
    const res = mockRes();
    await controller.confirmStripeSession({ params: { sessionId: "cs_1" } }, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// =====================================================================
describe("stripeWebhook : notification envoyée par Stripe", () => {
  test("signature invalide : 400 (protège contre les fausses notifications)", async () => {
    mockConstructEvent.mockImplementation(() => { throw new Error("bad signature"); });
    const res = mockRes();
    await controller.stripeWebhook({ headers: { "stripe-signature": "x" }, body: "{}" }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("checkout.session.completed : paiement enregistré et réservation confirmée", async () => {
    const booking = resa();
    mockConstructEvent.mockReturnValue({ type: "checkout.session.completed", data: { object: { id: "cs_1", payment_intent: "pi_9", metadata: { bookingId: 1 } } } });
    Booking.findByPk.mockResolvedValue(booking);
    Payment.findOne.mockResolvedValue(null);
    const res = mockRes();
    await controller.stripeWebhook({ headers: { "stripe-signature": "ok" }, body: "{}" }, res);
    expect(Payment.create).toHaveBeenCalledWith(expect.objectContaining({ referenceTransaction: "pi_9" }));
    expect(booking.statut).toBe("confirmee");
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  test("autre type d'événement : accusé de réception sans action", async () => {
    mockConstructEvent.mockReturnValue({ type: "payment_intent.created", data: { object: {} } });
    const res = mockRes();
    await controller.stripeWebhook({ headers: {}, body: "{}" }, res);
    expect(Payment.create).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

// =====================================================================
describe("PayPal", () => {
  test("createPaypalOrder : 200 et lien d'approbation", async () => {
    Booking.findByPk.mockResolvedValue(resa());
    paypalService.createOrder.mockResolvedValue({ id: "ORD1", links: [{ rel: "approve", href: "https://paypal.com/a" }] });
    const res = mockRes();
    await controller.createPaypalOrder({ params: { bookingId: 1 }, user: { id: 5, role: "locataire" } }, res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ orderId: "ORD1", url: "https://paypal.com/a" }));
  });

  test("createPaypalOrder : 403 pour un autre utilisateur", async () => {
    Booking.findByPk.mockResolvedValue(resa());
    const res = mockRes();
    await controller.createPaypalOrder({ params: { bookingId: 1 }, user: { id: 9, role: "locataire" } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test("capturePaypalOrder : paiement enregistré et réservation confirmée", async () => {
    const booking = resa();
    paypalService.captureOrder.mockResolvedValue({ purchase_units: [{ custom_id: "1", payments: { captures: [{ id: "CAP1" }] } }] });
    Booking.findByPk.mockResolvedValue(booking);
    Payment.findOne.mockResolvedValue(null);
    const res = mockRes();
    await controller.capturePaypalOrder({ params: { orderId: "ORD1" }, user: { id: 5, role: "locataire" } }, res);
    expect(Payment.create).toHaveBeenCalledWith(expect.objectContaining({ methode: "paypal", referenceTransaction: "CAP1" }));
    expect(booking.statut).toBe("confirmee");
  });

  test("capturePaypalOrder : 400 si PayPal ne renvoie pas la réservation", async () => {
    paypalService.captureOrder.mockResolvedValue({ purchase_units: [{}] });
    const res = mockRes();
    await controller.capturePaypalOrder({ params: { orderId: "ORD1" }, user: { id: 5 } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

// =====================================================================
describe("markBookingAsPaidManually : encaissement manuel (admin)", () => {
  test("un locataire ne peut pas marquer sa réservation comme payée : 403", async () => {
    const res = mockRes();
    await controller.markBookingAsPaidManually({ params: { bookingId: 1 }, user: { id: 5, role: "locataire" } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(Payment.create).not.toHaveBeenCalled();
  });

  test("admin : 201, paiement manuel enregistré", async () => {
    Booking.findByPk.mockResolvedValue(resa());
    Payment.findOne.mockResolvedValue(null);
    Payment.create.mockImplementation(async (d) => d);
    const res = mockRes();
    await controller.markBookingAsPaidManually({ params: { bookingId: 1 }, user: { id: 1, role: "admin" } }, res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(Payment.create).toHaveBeenCalledWith(expect.objectContaining({ methode: "manuel", statut: "paye" }));
  });

  test("admin : 400 si déjà payée", async () => {
    Booking.findByPk.mockResolvedValue(resa());
    Payment.findOne.mockResolvedValue({ id: 1 });
    const res = mockRes();
    await controller.markBookingAsPaidManually({ params: { bookingId: 1 }, user: { id: 1, role: "admin" } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

test("getMyPayments : filtre sur les réservations de l'utilisateur connecté", async () => {
  Payment.findAll.mockResolvedValue([]);
  const res = mockRes();
  await controller.getMyPayments({ user: { id: 5 } }, res);
  expect(res.status).toHaveBeenCalledWith(200);
  expect(Payment.findAll.mock.calls[0][0].include[0].where).toEqual({ userId: 5 });
});
