import { resetTestDatabase } from "@aiw/database/testing";

export default async function setup() {
  await resetTestDatabase();
}
