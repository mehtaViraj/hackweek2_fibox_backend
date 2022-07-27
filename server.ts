import express, { Express, Request, Response } from "express";
import dotenv from "dotenv";
import axios from "axios";
import { Pool, PoolConfig } from "pg";

dotenv.config();
const app: Express = express();
const port = process.env.PORT || 4000;

const dbConfig: PoolConfig = {
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE ?? "hackweek2",
  port: parseInt(process.env.DB_PORT ?? "5432"),
  password: process.env.DB_PASSWORD,
  max: 100,
  idleTimeoutMillis: 30000,
  ssl: process.env.DB_SSL ? { rejectUnauthorized: false } : false,
};
const pool = new Pool(dbConfig);

const PLAID_URL = "https://sandbox.plaid.com";
const PLAID_CREDS = {
  client_id: process.env.PLAID_client_id!,
  secret: process.env.PLAID_sandbox_secret_key!,
};

const responseObj = (hasSucceeded: boolean, message: string = '', data: any = {}) => {
  return({
    result: hasSucceeded ? 'success' : 'failed',
    message: message,
    data: data
  })
}

async function verifyInstance(user: string, token: number) {
  const res = await pool.query(`
    SELECT * FROM public.users
    WHERE username=$1 AND instance_id=$2
  `, [user, token])
  return((res.rowCount !== 0))
}

app.get("/", (req: Request, res: Response) => {
  res.send("Express + TypeScript Server");
});

app.get("/signup", async (req: Request, res: Response) => {
  if (!req.query.username || !req.query.password) {
    res.status(400).send(responseObj(false, 'Incomplete signup'));
  } else {
    try {
      await pool.query(`
      INSERT INTO public.users(
        username, password)
      VALUES ($1, $2);
      `, [req.query.username, req.query.password]);
      res.status(200).send(responseObj(true));
    } catch (e) {
      console.log(e);
      res.status(400).send(responseObj(false, 'Could not create user'));
    }
  }
});

app.get("/login", async (req: Request, res: Response) => {
  if (!req.query.username || !req.query.password) {
    res.status(400).send();
  } else {
    try {
      const users = await pool.query(
        `
      SELECT * FROM public.users
      WHERE username=$1;
      `,
        [req.query.username]
      );
      if (users.rowCount === 0) {
        res.status(200).send(responseObj(false, 'User not found'));
        return;
      }
      if (users.rows[0].password != req.query.password) {
        res.status(200).send(responseObj(false, 'Wrong password'));
        return;
      }
      const instance_token = Math.floor(Math.random() * (10**7))
      await pool.query(`
        UPDATE public.users
        SET instance_id=$2
        WHERE username=$1;
      `, [req.query.user as string, instance_token as number])
      res.status(200).send(responseObj(true, '', {token: instance_token}))
    } catch (e) {
      console.log(e);
      res.status(500).send(responseObj(false, 'Server Error'));
    }
  }
});

app.get("/newLinkToken", async (req: Request, res: Response) => {
  await axios
    .post(`${PLAID_URL}/link/token/create`, {
      ...PLAID_CREDS,
      client_name: "Hackweek 2 Express Server",
      language: "en",
      country_codes: ["CA"],
      user: {
        client_user_id: "user-id",
      },
      products: ["auth", "transactions"],
    })
    .then((response) => {
      let sendback = response.data;
      delete sendback.request_id;
      res.status(200).send(responseObj(true, '', sendback));
    })
    .catch((err) => {
      console.log(err);
      res.status(500).send(responseObj(false, 'Plaid Error'));
    });
});

app.get("/submitPublicToken", async (req: Request, res: Response) => {
  if (!req.params.token) {
    res.status(400).send(responseObj(false, 'No token supplied'));
  } else {
    await axios
      .post(`${PLAID_URL}/item/public_token/exchange`, {
        ...PLAID_CREDS,
        public_token: req.params.token,
      })
      .then((response) => {
        console.log(response.data);
        res.status(200).send(responseObj(true));
      })
      .catch((err) => {
        console.log(err);
        res.status(500).send(responseObj(false, 'Plaid Error'));
      });
  }
});

app.listen(port, () => {
  console.log(`⚡️[server]: Server is running at http://localhost:${port}`);
});
