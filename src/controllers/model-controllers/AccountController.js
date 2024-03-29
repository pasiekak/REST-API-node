const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const BaseController = require("../BaseController");
const AccountService = require("../../services/model-services/AccountService");
const accountService = new AccountService();
const models = require("../../seqDB/models");
const genAPIKey = require("../../utils/apiKeyGenerator");
const bcrypt = require("bcrypt");
const { Op } = require("sequelize");
class AccountController extends BaseController {
  constructor() {
    super(accountService);
  }
  // Override
  getOne = async (req, res) => {
    let id = req.params.id;
    let found = await accountService.findOne({
      where: { id: id },
      attributes: {
        exclude: ["hash", "api_key", "RoleId", "ClientId", "OperatorId"],
      },
      include: [
        { model: models.Role, attributes: { exclude: ["id"] } },
        {
          model: models.Operator,
          include: [
            {
              model: models.Commission,
              as: "ContractorCommissions",
              attributes: ["id"],
              separate: true,
              order: [["createdAt", "DESC"]],
            },
          ],
        },
        { model: models.Image },
        {
          model: models.Client,
          include: [
            {
              model: models.Commission,
              as: "AuthorCommissions",
              attributes: ["id"],
              separate: true,
              order: [["createdAt", "DESC"]],
            },
          ],
        },
        {
          model: models.Statistics,
          attributes: { exclude: ["api_key", "id"] },
        },
      ],
    });
    if (found) return res.status(200).send({ success: true, message: "Pobrano rekord.", data: found });
    return res.status(404).send({
      success: false,
      message: "Nie odnaleziono takiego użytkownika.",
    });
  };
  // New methods here
  authenticate = async (req, res) => {
    let { login, password } = req.body;
    try {
      const account = await accountService.authenticate(login, password);
      if (account) {
        // Setting up JWT
        const role = await account.getRole();
        const payload = {
          login: account.login,
          email: account.email,
          Role: role,
          id: account.id,
        };
        const token = jwt.sign(payload, process.env.JWT_SECRET, {
          expiresIn: "3h",
        });
        // CHANGE SECURE ON PRODUCTION
        res.cookie("Authorization", `Bearer ${token}`, {
          expires: new Date(Date.now() + 3 * 60 * 60 * 1000),
          secure: false,
          httpOnly: true,
        });
        res.cookie("User", { Role: payload.Role, id: payload.id }, { expires: new Date(Date.now() + 3 * 60 * 60 * 1000 - 1000) });
        return res.status(200).send({ success: true, message: "Pomyślnie zalogowano." });
      }
      return res.status(401).send({ success: false, message: "Nie ma takiego konta." });
    } catch (error) {
      console.log(error);
      return res.status(500).send({ success: false, message: "Wystąpił błąd." });
    }
  };
  logout = async (req, res) => {
    try {
      res.clearCookie("User");
      res.clearCookie("Authorization");
      return res.status(200).send({ success: true, message: "Pomyślnie wylogowano." });
    } catch (err) {
      return res.status(500).send({ success: false, message: "Nie udało się wylogować konta." });
    }
  };

  registerFirstStep = async (req, res) => {
    try {
      const { login, email, wantToBeOperator } = req.body;
      const user = await accountService.findOne({
        where: { [Op.or]: [{ login: login }, { email: email }] },
      });
      if (user !== null) return res.status(409).send({ success: false, message: "Taki użytkownik już istnieje." });
      let newKey = genAPIKey();
      let ok = false;
      while (!ok) {
        const apiKeyUsed = await accountService.findOne({
          where: { api_key: newKey },
        });
        if (apiKeyUsed === null) {
          ok = true;
        } else {
          newKey = genAPIKey();
        }
      }
      const payload = {
        login,
        email,
        api_key: newKey,
        hash: bcrypt.hashSync(req.body.password, 12),
        RoleId: wantToBeOperator ? 2 : 3,
      };
      const token = jwt.sign(payload, process.env.JWT_SECRET, {
        expiresIn: "7d",
      });
      const transporter = nodemailer.createTransport({
        service: "gmail",
        secure: false,
        auth: {
          user: process.env.MAIL_USER,
          pass: process.env.MAIL_PASS,
        },
      });
      const mailOptions = {
        from: process.env.MAIL_USER,
        to: payload.email,
        subject: "Aktywacja konta",
        html: `<a href="http://localhost:3000/auth/activation?token=${token}">Link aktywacyjny</a>`,
      };

      transporter.sendMail(mailOptions, (err, info) => {
        if (err) {
          res.status(503).send({ success: false, message: "Nie udało się wysłać maila." });
        } else {
          res.status(200).send({
            success: true,
            message: "Wysłaliśmy maila na twój adres email.",
          });
        }
      });
    } catch (err) {
      console.log(err);
      return res.status(500).send({ success: false, message: "Wystąpił błąd." });
    }
  };

  register = async (req, res) => {
    try {
      const token = req.query.token;

      const decodedToken = jwt.decode(token, { complete: true });
      if (!decodedToken) {
        return res.status(403).send({
          success: false,
          message: "Nieautoryzowana próba weryfikacji konta.",
        });
      } else {
        const { login, email, api_key, hash, RoleId } = decodedToken.payload;
        await accountService.create({ login, email, api_key, hash, RoleId });
        return res.status(201).send({
          success: true,
          message: "Pomyślnie zweryfikano użytkownika i utworzono konto.",
        });
      }
    } catch (err) {
      console.log(err);
      if (err.message === "Validation error")
        return res.status(422).send({
          success: false,
          message: "Wystąpił błąd przy tworzeniu konta.",
        });
      return res.status(500).send({ success: false, message: "Wystąpił błąd." });
    }
  };
}

module.exports = AccountController;
