import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { WageringModule } from './modules/wagering/wagering.module';
import config from './mikro-orm.config';

@Module({
  imports: [
    MikroOrmModule.forRoot(config),
    WageringModule
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
