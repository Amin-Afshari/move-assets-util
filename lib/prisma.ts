import { PrismaClient } from "../generated/prisma";
// import { PrismaPg } from '@prisma/adapter-pg';
import { withAccelerate } from "@prisma/extension-accelerate";

// const adapter = new PrismaPg({
//   connectionString: process.env.DATABASE_URL,
// });
// const prisma = new PrismaClient({ adapter });

const prisma = new PrismaClient({
  accelerateUrl: process.env.DATABASE_URL,
}).$extends(withAccelerate());

export { prisma };
