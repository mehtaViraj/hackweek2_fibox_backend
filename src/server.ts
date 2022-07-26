import express, { Express, Request, Response } from "express";
import dotenv from "dotenv";
import axios from "axios";
import cors from "cors";
import { Pool, PoolConfig } from "pg";

dotenv.config();
const app: Express = express();
app.use(cors())
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
      `, [req.query.username as string, instance_token as number])
      res.status(200).send(responseObj(true, '', {token: instance_token}))
    } catch (e) {
      console.log(e);
      res.status(500).send(responseObj(false, 'Server Error'));
    }
  }
});

app.get("/newLinkToken", async (req: Request, res: Response) => {
  if (!req.query.username) {
    res.status(400).send(responseObj(false, 'No username'))
  } else {
    await axios
      .post(`${PLAID_URL}/link/token/create`, {
        ...PLAID_CREDS,
        client_name: "Hackweek 2 Express Server",
        language: "en",
        country_codes: ["CA", "US"],
        user: {
          client_user_id: req.query.username,
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
  }
});

app.get("/submitPublicToken", async (req: Request, res: Response) => {
  if (!req.query.token || !req.query.username || !req.query.public_token) {
    res.status(400).send(responseObj(false, 'Either Token or Username missing'));
  } else {
    const isVerified = await verifyInstance(req.query.username as string, parseInt(req.query.token as string))
    if (!isVerified) {
      res.status(403).send(responseObj(false, 'Invalid user'))
    } else {
      await axios
        .post(`${PLAID_URL}/item/public_token/exchange`, {
          ...PLAID_CREDS,
          public_token: req.query.public_token,
        })
        .then(async (response) => {
          // console.log(response.data);
          const cur_res = await pool.query(`
            SELECT * FROM public.users
            WHERE username=$1;
          `, [req.query.username])
          let cur_tokens: string = cur_res.rows[0].plaid_tokens;
          if (!cur_tokens) {
            cur_tokens = ''
          }
          let tokens_ls =  cur_tokens.split('~')
          tokens_ls.push(`${response.data.access_token}|${response.data.item_id}`)
          const new_tokens = tokens_ls.join('~')
          await pool.query(`
            UPDATE public.users
            SET plaid_tokens=$2
            WHERE username=$1;
          `, [req.query.username as string, new_tokens as string])
          res.status(200).send(responseObj(true));
        })
        .catch((err) => {
          console.log(err);
          res.status(500).send(responseObj(false, 'Plaid Error'));
        });
    }
  }
});

app.get("/getAllAccountData", async (req: Request, res: Response) => {

  let accountsLS: Array<any> = []
  async function pushAccountData(accessToken: string) {
      try {
      const res = await axios.post(`${PLAID_URL}/accounts/balance/get`, {
        ...PLAID_CREDS,
        access_token: accessToken,
      })
      const item_id = res.data.item.item_id 
      const returnData = res.data.accounts.map((i: any) => {return({...i, item_id: item_id})})
      accountsLS = accountsLS.concat(returnData);
  } catch(e) {
    console.log(e)
    // console.log(accessToken)
  }
  }

  if (!req.query.token || !req.query.username ) {
    res.status(400).send(responseObj(false, 'Either Token or Username missing'));
  } else {
    const isVerified = await verifyInstance(req.query.username as string, parseInt(req.query.token as string))
    if (!isVerified) {
      res.status(403).send(responseObj(false, 'Invalid user'))
    } else {
      try {
        const cur_res = await pool.query(`
          SELECT * FROM public.users
          WHERE username=$1;
        `, [req.query.username])

        let cur_tokens: string = cur_res.rows[0].plaid_tokens;
        if (!cur_tokens) {
          cur_tokens = ''
        }
        let tokens_ls =  cur_tokens.split('~')

        await Promise.all(
          tokens_ls
            .filter((i) => (i && i.length !== 0))
            .map((tokenPair) => {return tokenPair.split('|')[0]})
            .map((access_token) => {return(pushAccountData(access_token))})
        )

        res.status(200).send(responseObj(true, '', accountsLS))
      } catch(e) {
        console.log(e);
        res.status(500).send(responseObj(false, 'server error'))
      }
    }
  }
});

app.get("/getTransactions", async (req: Request, res: Response) => {
  if (!req.query.token || !req.query.username || !req.query.account_id || !req.query.item_id) {
    res.status(400).send(responseObj(false, 'Request parameters missing'));
  } else {
    const isVerified = await verifyInstance(req.query.username as string, parseInt(req.query.token as string))
    if (!isVerified) {
      res.status(403).send(responseObj(false, 'Invalid user'))
    } else {
      try {
        const cur_res = await pool.query(`
          SELECT * FROM public.users
          WHERE username=$1;
        `, [req.query.username])

        let cur_tokens: string = cur_res.rows[0].plaid_tokens;
        if (!cur_tokens) {
          cur_tokens = ''
        }
        let tokens_ls: any =  cur_tokens.split('~')
        tokens_ls = tokens_ls.map((i: string) => {return(i.split('|'))})

        let access_token: string|null = null;
        for (const tokenPair of tokens_ls) {
          if(tokenPair[1] === req.query.item_id) {
            access_token = tokenPair[0];
          }
        }

        if (!access_token) {
          res.status(400).send(responseObj(false, 'Invalid item_id'));
        } else {
          await axios.post(`${PLAID_URL}/transactions/get`, {
            ...PLAID_CREDS,
            access_token: access_token,
            start_date: "2022-01-01",
            end_date: "2022-12-01",
            options: {
              count: 35,
              account_ids: [req.query.account_id]
            }
          }).then( (response) => {
            const resData = response.data.transactions
            res.status(200).send(responseObj(true, '', resData))
          })
        }
      } catch(e) {
        console.log(e);
        res.status(500).send(responseObj(false, 'server error'))
      }
    }
  }
})

app.listen(port, () => {
  console.log(`⚡️[server]: Server is running at http://localhost:${port}`);
});
