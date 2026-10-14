package com.fjsp.business.config;

import javax.sql.DataSource;

import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.annotation.Profile;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.datasource.init.DatabasePopulatorUtils;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;
import org.springframework.stereotype.Component;

/** Local uses Hibernate update rather than Flyway; apply the constraints Hibernate cannot create. */
@Component
@Profile("local")
@Order(Ordered.HIGHEST_PRECEDENCE)
public class LocalSchemaInitializer implements ApplicationRunner {

    private final DataSource dataSource;

    public LocalSchemaInitializer(DataSource dataSource) {
        this.dataSource = dataSource;
    }

    @Override
    public void run(ApplicationArguments args) {
        // Reuse the versioned SQL instead of maintaining divergent local copies.
        // Existing duplicate active rows fail closed; never delete user data automatically.
        ResourceDatabasePopulator populator = new ResourceDatabasePopulator(
                new ClassPathResource("db/migration/V5__execution_record_running_unique.sql"),
                new ClassPathResource("db/migration/V6__execution_feedback_enhancement.sql"),
                new ClassPathResource("db/migration/V13__plan_version_single_active.sql"));
        DatabasePopulatorUtils.execute(populator, dataSource);
    }
}
