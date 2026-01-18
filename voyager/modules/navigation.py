class NavigationModule:
    def __init__(self):
        self.last_direction = None

    def choose_direction(self):
        import random

        directions = [
            (1, 0),
            (0, 1),
            (-1, 0),
            (0, -1),
            (1, 1),
            (-1, -1),
            (1, -1),
            (-1, 1),
        ]
        self.last_direction = random.choice(directions)
        return self.last_direction

    def get_instruction(self):
        if self.last_direction is None:
            self.choose_direction()
        dx, dz = self.last_direction
        return f"Explore toward direction ({dx}, {dz}) before starting task."
