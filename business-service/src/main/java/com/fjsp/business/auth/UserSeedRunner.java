package com.fjsp.business.auth;

import java.util.List;
import java.util.UUID;

import com.fjsp.business.entity.AppUser;
import com.fjsp.business.repository.AppUserRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;

/**
 * 启动时补齐 4 个种子账号（按 username 幂等）。
 * 生产路径由 Flyway V3 建表+插入；local profile（Flyway 关闭）由本 runner 保证账号存在。
 * 密码仅用于本地演示，见 README。
 */
@Component
public class UserSeedRunner implements ApplicationRunner {

    public static final String SEED_PASSWORD = "Fj@123456";

    private static final Logger log = LoggerFactory.getLogger(UserSeedRunner.class);

    private record SeedUser(String username, String role, String displayName) {
    }

    private static final List<SeedUser> SEED_USERS = List.of(
            new SeedUser("dispatcher", "DISPATCHER", "调度员"),
            new SeedUser("reviewer", "REVIEWER", "审核员"),
            new SeedUser("manager", "PRODUCTION_MANAGER", "生产主管"),
            new SeedUser("admin", "ADMIN", "管理员"));

    private final AppUserRepository userRepository;
    private final PasswordEncoder passwordEncoder;

    public UserSeedRunner(AppUserRepository userRepository, PasswordEncoder passwordEncoder) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
    }

    @Override
    public void run(ApplicationArguments args) {
        for (SeedUser seed : SEED_USERS) {
            if (userRepository.existsByUsername(seed.username())) {
                continue;
            }
            AppUser user = new AppUser();
            user.setId(UUID.randomUUID().toString());
            user.setUsername(seed.username());
            user.setPasswordHash(passwordEncoder.encode(SEED_PASSWORD));
            user.setRole(seed.role());
            user.setDisplayName(seed.displayName());
            user.setEnabled(true);
            userRepository.save(user);
            log.info("seeded demo user {} ({})", seed.username(), seed.role());
        }
    }
}
