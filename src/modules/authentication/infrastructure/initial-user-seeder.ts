import { Injectable, OnModuleInit } from '@nestjs/common';
import { SeedInitialUserUseCase } from '../application/seed-initial-user.use-case.js';

@Injectable()
export class InitialUserSeeder implements OnModuleInit {
  constructor(private readonly seedInitialUser: SeedInitialUserUseCase) {}

  async onModuleInit(): Promise<void> {
    await this.seedInitialUser.execute(process.env.AUTH_SEED_EMAIL, process.env.AUTH_SEED_PASSWORD);
  }
}
