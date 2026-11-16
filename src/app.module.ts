import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { WageringModule } from './modules/wagering/wagering.module';
import config from './mikro-orm.config';
import { AuthenticationModule } from './modules/authentication/authentication.module';

@Module({
  imports: [
    MikroOrmModule.forRoot(config),
    AuthenticationModule,
    WageringModule
  ],
})
export class AppModule {}
