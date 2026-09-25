-- SPDX-License-Identifier: AGPL-3.0-or-later
-- SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

-- Sample data for the evaluation stack (compose.demo.yaml). Loaded once, by the postgres image's
-- docker-entrypoint-initdb.d, into the `sample` database.
--
-- It exists so the first backup has something recognisable inside it: enough rows that the
-- artifact is not an empty file, few enough that the whole round trip — dump, encrypt, upload,
-- download, decrypt, restore into a throwaway database — finishes in seconds.
--
-- None of it is real. Every name, address and email below is invented for this file.

CREATE TABLE customers (
  id         integer PRIMARY KEY,
  name       text        NOT NULL,
  email      text        NOT NULL UNIQUE,
  city       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id          integer PRIMARY KEY,
  customer_id integer     NOT NULL REFERENCES customers (id),
  item        text        NOT NULL,
  total_cents integer     NOT NULL CHECK (total_cents >= 0),
  placed_at   timestamptz NOT NULL
);

CREATE INDEX orders_customer_id_idx ON orders (customer_id);

INSERT INTO customers (id, name, email, city) VALUES
  (1, 'Ada Mercer',      'ada@example.invalid',      'Lisbon'),
  (2, 'Bruno Castel',    'bruno@example.invalid',    'Porto'),
  (3, 'Clara Vidal',     'clara@example.invalid',    'Madrid'),
  (4, 'Dario Fontes',    'dario@example.invalid',    'Seville'),
  (5, 'Elena Braga',     'elena@example.invalid',    'Recife'),
  (6, 'Fabio Norte',     'fabio@example.invalid',    'Curitiba'),
  (7, 'Greta Almeida',   'greta@example.invalid',    'Belem'),
  (8, 'Hugo Salvatore',  'hugo@example.invalid',     'Naples');

-- 240 orders spread over the last eight months, so `SELECT count(*)` after a restore is a number
-- worth checking rather than a handful of rows you could have retyped.
INSERT INTO orders (id, customer_id, item, total_cents, placed_at)
SELECT
  n,
  ((n - 1) % 8) + 1,
  (ARRAY['desk lamp', 'notebook', 'espresso cup', 'keyboard', 'monitor arm', 'floor mat'])[((n - 1) % 6) + 1],
  1500 + ((n * 137) % 18500),
  now() - ((n % 240) * interval '1 day')
FROM generate_series(1, 240) AS n;

-- A view and a sequence as well: a logical dump has to carry more than tables, and a restore that
-- only brought the rows back would still be a restore that lost half the schema.
CREATE VIEW orders_per_customer AS
SELECT c.id, c.name, count(o.id) AS orders, sum(o.total_cents) AS total_cents
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
GROUP BY c.id, c.name;

CREATE SEQUENCE order_id_seq START WITH 241 OWNED BY orders.id;
