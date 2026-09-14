import { resetTestDatabase } from "../src/testing";

export default async function setup() {
  await resetTestDatabase();
}
